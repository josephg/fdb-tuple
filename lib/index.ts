// This file implements the tuple layer. More details are here:
// https://apple.github.io/foundationdb/data-modeling.html#tuples
//
// And the typecodes are here:
// https://github.com/apple/foundationdb/blob/master/design/tuple.md
//
// This code supports:
// - null, true, false
// - integers
// - byte string
// - unicode string
// - float, double
// - uuid
//
//
// It does not support:
// - 64 bit IDs
// - user type codes
//
// Note the javascript number types don't neatly match the number types used in
// tuple encoding. For compatibility, by default all javascript integer numbers
// are encoded using the integer tuple types. This means in the byte encoding
// (and thus in key ordering), all non-integers are greater than all integers.
// Eg the tuple key for 0.5 > tuple key for 1. You can force the tuple encoding
// to encode a number as a float / double by wrapping your key in an object -
// {type: 'float' | 'double', value: XXX}. Any number that is an integer outside
// the safe range will be encoded as a double. If you want to preserve exact
// byte encodings of inputs, you can pass `true` as the final argument to decode.
//
// Also note that tuple values can encode integers larger than the safe range
// supported by javascript's number type. You will run into these numbers when
// interoperating with bindings in other languages, or when decoding tuple
// values containing bigints. Any integer outside the javascript safe range will
// be decoded into a BigInt.
//
// Note when encoding bigints: The tuple encoding does not differentiate between
// the encoding for an integer and a bigint. Any integer inside the JS safe
// range for a number will be decoded to a 'number' rather than a 'bigint'. So
// for instance: decode(encode(2n**53n)) === 2n**53n but decode(encode(10n)) ===
// 10.

import assert = require('assert')

type UnboundStamp = {data: Buffer, stampPos: number, codePos?: number}

// Marginally faster than Buffer.concat
export const concat2 = (a: Buffer, b: Buffer) => {
  const result = Buffer.alloc(a.length + b.length)
  a.copy(result, 0)
  b.copy(result, a.length)
  return result
}

const UNSET_TR_VERSION = Buffer.alloc(10).fill(0xff)

// Safe to return in short-circuit evaluation because unless you do something
// weird, an empty buffer is immutable.
const BUF_EMPTY = Buffer.alloc(0)

const numByteLen = (num: number) => {
  let max = 1
  for (let i = 0; i <= 8; i++) {
    if (num < max) return i
    max *= 256
  }
  throw Error('Number too big for encoding')
}

enum Code {
  Null = 0,
  Bytes = 1,
  String = 2,
  Nested = 0x5,
  IntZero = 0x14,
  PosIntEnd = 0x1d,
  NegIntStart = 0x0b,
  Float = 0x20,
  Double = 0x21,
  False = 0x26,
  True = 0x27,
  UUID = 0x30,
  // There's also an 80 bit versionstamp, but none of the other bindings use it.
  
  Versionstamp = 0x33, // Writing versionstamps not yet supported.
}

/**
 * Supported tuple item types.
 * This awkwardness brought to you by:
 * https://github.com/unional/typescript-guidelines/blob/master/pages/advance-types/recursive-types.md
 */
export type TupleItem = null | Buffer | string | TupleArr | number | BigInt | boolean | {
  type: 'uuid', value: Buffer
} | {
  /**
   * This is flattened into a double during decoding if noCanonicalize is
   * true. NaN has multiple binary encodings and node normalizes NaN to a
   * single binary layout. To preserve the binary representation of NaNs
   * across encoding / decoding, we'll store the original NaN encoding on the
   * object. This is needed for the binding tester to pass.
   */
  type: 'float', value: number, /** @deprecated */ rawEncoding?: Buffer, // Encoding needed to pass binding tester
} | {
  /** As type: float, although this is only used for noCanonicalize + NaN value. */
  type: 'double', value: number, /** @deprecated */ rawEncoding?: Buffer,
} | {
  // Lets talk a bit about versionstamps. They're a really useful feature, but
  // they totally wreck all our abstractions, because the versionstamp doesn't
  // get filled in until we commit the transaction. This means:
  //
  // - The data field for a versionstamp is optional. If its missing, that
  //   means we'll fill it in on commit
  // - Tuples can only contain have one incomplete versionstamp. When setting
  //   a value using tuples, either the key or the value can contain a
  //   versionstamp but not both.
  // - There's a dodgy escape hatch so that txn.set() will use
  //   setVersionstampedKey or setVersionstampedValue when committing
  // - TODO: Ideally the versionstamp itself in the tuple should get filled in
  //   on commit

  // Buffer will be 12 bytes long. The first 10 bytes contain the database-
  // internal version, then 2 byte user version (which is usually the offset
  // within the transaction).
  type: 'versionstamp', value: Buffer
} | {
  type: 'unbound versionstamp', code?: number
}

interface TupleArr extends Array<TupleItem> {}

/** This helper only exists because {type: 'unbound versionstamp'} is so awful to type. */
export const unboundVersionstamp = (code?: number): TupleItem => ({type: 'unbound versionstamp', code})

// const falseByte = Buffer.from([Code.False])
// const trueByte = Buffer.from([Code.True])

/**
 * Begin and end prefixes which contain all tuple children at some key.
 */
export const rawRange = {
  begin: Buffer.from([0x00]), end: Buffer.from([0xff])
}

// This helper works around a bug in typescript related to bigint:
// https://github.com/microsoft/TypeScript/issues/36155
const isBigInt = (x: TupleItem): x is BigInt => typeof x === 'bigint'

class BufferBuilder {
  storage: Buffer
  used: number = 0

  constructor(capacity: number = 64) {
    this.storage = Buffer.alloc(capacity)
  }

  make() {
    const result = Buffer.alloc(this.used)
    this.storage.copy(result, 0, 0, this.used)
    return result
  }

  need(numBytes: number) {
    if (this.storage.length < this.used + numBytes) {
      let newAmt = this.storage.length
      while (newAmt < this.used + numBytes) newAmt *= 2
      const newStorage = Buffer.alloc(newAmt)
      this.storage.copy(newStorage)
      this.storage = newStorage
    }
  }

  appendByte(val: number) { this.need(1); this.storage[this.used++] = val }

  appendString(val: string) {
    const len = Buffer.byteLength(val)
    this.need(len)
    this.storage.write(val, this.used)
    this.used += len
  }

  appendBuffer(val: Buffer) {
    this.need(val.length)
    val.copy(this.storage, this.used)
    this.used += val.length
  }

  // This returns a slice into the specified number of bytes that the caller
  // can fill. Note the slice is only valid until the next call to a write
  // function. Write into the slice before then.
  writeInto(numBytes: number): Buffer {
    this.need(numBytes)
    this.used += numBytes
    return this.storage.slice(this.used - numBytes, this.used)
  }

  // appendZeros(num: number) {
  //   this.need(num)
  //   this.used += num
  // }

  // appendU16BE(num: number) {
  //   this.need(2)
  //   this.storage.writeUInt16BE(num, this.used)
  //   this.used += 2
  // }
}

const adjustFloat = (data: Buffer, isEncode: boolean) => {
  if((isEncode && (data[0] & 0x80) === 0x80) || (!isEncode && (data[0] & 0x80) === 0x00)) {
    for(var i = 0; i < data.length; i++) {
      data[i] = ~data[i]
    }
  } else data[0] ^= 0x80
  return data
}

type VersionstampPos = {stamp?: number, code?: number}
/** Internal method. Use pack() below */
const encode = (into: BufferBuilder, item: TupleItem, versionstampPos: VersionstampPos) => {
  if (item === undefined) throw new TypeError('Packed element cannot be undefined')
  else if (item === null) into.appendByte(Code.Null)
  else if (item === false) into.appendByte(Code.False)
  else if (item === true) into.appendByte(Code.True)
  else if (Buffer.isBuffer(item) || typeof item === 'string') {
    let isString: boolean
    let itemBuf: Buffer

    if (typeof item === 'string') {
      itemBuf = Buffer.from(item, 'utf8')
      into.appendByte(Code.String)
    } else {
      itemBuf = item
      into.appendByte(Code.Bytes)
    }

    for (let i = 0; i < itemBuf.length; i++) {
      const val = itemBuf.readUInt8(i)
      into.appendByte(val)
      if (val === 0) into.appendByte(0xff)
    }
    into.appendByte(0)

  } else if (Array.isArray(item)) {
    // Embedded child tuple.
    into.appendByte(Code.Nested)
    for (let i = 0; i < item.length; i++) {
      encode(into, item[i], versionstampPos)
      if (item[i] == null) into.appendByte(0xff)
    }
    into.appendByte(0)

  } else if (typeof item === 'number') {
    if (Number.isSafeInteger(item) && !Object.is(item, -0)) {
      let absItem = Math.abs(item)
      let byteLen = numByteLen(absItem)
      into.need(1 + byteLen)

      into.appendByte(Code.IntZero + (item < 0 ? -byteLen : byteLen))

      let lowBits = (absItem & 0xffffffff) >>> 0
      let highBits = ((absItem - lowBits) / 0x100000000) >>> 0
      if (item < 0) {
        lowBits = (~lowBits)>>>0
        highBits = (~highBits)>>>0
      }

      for (; byteLen > 4; --byteLen) into.appendByte(highBits >>> (8*(byteLen-5)))
      for (; byteLen > 0; --byteLen) into.appendByte(lowBits >>> (8*(byteLen-1)))
      
    } else {
      // Encode as a double precision float.
      into.appendByte(Code.Double)

      // We need to look at the representation bytes - which needs a temporary buffer.
      const bytes = Buffer.allocUnsafe(8)
      bytes.writeDoubleBE(item, 0)
      adjustFloat(bytes, true)
      into.appendBuffer(bytes)
    }
  } else if (isBigInt(item)) {
    const biZero = BigInt(0)
    // throw new Error('BigInts are not yet supported by this library')
    if (item === biZero) {
      into.appendByte(Code.IntZero)
    } else {
      const isNeg = item < biZero
      // String based conversion like this is pretty inefficient. It could be sped
      // up using https://www.npmjs.com/package/bigint-buffer or something similar.
      const rawHexBytes = (isNeg ? -item : item).toString(16)
      const rawBytes = Buffer.from(((rawHexBytes.length % 2 === 1) ? '0' : '') + rawHexBytes, 'hex')
      const len = rawBytes.length

      if (len > 255) throw Error('Tuple encoding does not support bigints larger than 255 bytes.')

      if (isNeg) {
        // Encode using 1s compliment - flip the bits.
        for (let i = 0; i < rawBytes.length; i++) rawBytes[i] = ~rawBytes[i]
      }

      if (len <= 8) {
        // Normal integer encoding. This is required for sorting to be correct
        // but these numbers might not round-trip into bigints.
        into.appendByte(Code.IntZero + (isNeg ? -len : len))
      } else if (len < 256) {
        into.appendByte(isNeg ? Code.NegIntStart : Code.PosIntEnd)
        into.appendByte(isNeg ? len ^ 0xff : len)
      }
      into.appendBuffer(rawBytes)
    }

  } else if (typeof item === 'object' && (item.type === 'float' || item.type === 'double')) {
    const isFloat = item.type === 'float'
    into.appendByte(isFloat ? Code.Float : Code.Double)
    let bytes
    if (item.rawEncoding) bytes = Buffer.from(item.rawEncoding)
    else {
      bytes = Buffer.allocUnsafe(isFloat ? 4 : 8)
      if (isFloat) bytes.writeFloatBE(item.value, 0)
      else bytes.writeDoubleBE(item.value, 0)
      // console.error('encode item', item, bytes)
      // throw new Error('asdfsdf')
    }
    adjustFloat(bytes, true)
    into.appendBuffer(bytes)
  } else if (typeof item === 'object' && item.type === 'uuid') {
    into.appendByte(Code.UUID)
    assert(item.value.length === 16, 'Invalid UUID: Should be 16 bytes exactly')
    into.appendBuffer(item.value)

  } else if (typeof item === 'object' && item.type === 'unbound versionstamp') {
    into.appendByte(Code.Versionstamp)
    if (versionstampPos.stamp != null) throw new TypeError('Tuples may only contain 1 unset versionstamp')
    versionstampPos.stamp = into.used
    into.writeInto(10).fill(0xff)
    if (item.code != null) {
      into.writeInto(2).writeUInt16BE(item.code, 0)
    } else {
      versionstampPos.code = into.used
      into.writeInto(2)
    }
  } else if (typeof item === 'object' && item.type === 'versionstamp') {
    into.appendByte(Code.Versionstamp)
    into.appendBuffer(item.value)
  } else {
    let x: never = item // Compile error if this is legitimately reachable
    throw new TypeError('Packed items must be basic types or lists')
  }
}

function packRaw(arr?: TupleItem | TupleItem[]): Buffer | UnboundStamp {
  if (arr === undefined || Array.isArray(arr) && arr.length === 0) return BUF_EMPTY

  // if (!Array.isArray(arr)) throw new TypeError('fdb.tuple.pack must be called with an array')
  const versionstampPos: VersionstampPos = {}
  const builder = new BufferBuilder()

  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      encode(builder, arr[i], versionstampPos)
      // console.log('pack', arr[i], builder.storage)
    }
  } else encode(builder, arr, versionstampPos)    

  const data = builder.make()
  return versionstampPos.stamp == null
    ? data
    : {data, stampPos: versionstampPos.stamp, codePos: versionstampPos.code}
}

/**
 * Encode the specified item or array of items into a buffer.
 *
 * pack() and unpack() are the main entrypoints most people will use when using
 * this library.
 *
 * `pack(x)` is equivalent to `pack([x])` if x is not itself an array. Packing
 * single items this way is also slightly more efficient.
 */
export const pack = (arr?: TupleItem | TupleItem[]): Buffer => {
  const pack = packRaw(arr)
  if (!Buffer.isBuffer(pack)) throw new TypeError('Incomplete versionstamp included in vanilla tuple pack')
  return pack
}

/**
 * This variant of pack is used to encode a tuple with an unbound versionstamp
 * inside.
 *
 * It returns the buffer paired with metadata about where inside the returned
 * value the versionstamp should be written.
 *
 * The passed array must, when flattened contain exactly one unbound
 * versionstamp.
 */
export const packUnboundVersionstamp = (arr?: TupleItem | TupleItem[]): UnboundStamp => {
  const pack = packRaw(arr)
  if (Buffer.isBuffer(pack)) throw new TypeError('No incomplete versionstamp included in tuple pack with versionstamp')
  return pack
}


// *** Decode

function decodeBigInt(buf: Buffer, offset: number, numBytes: number, isNeg: boolean): BigInt {
  let num = BigInt(0)
  let shift = 0
  for (let i = numBytes-1; i >= 0; --i) {
    let b = buf[offset+i]
    if (isNeg) b = ~b & 0xff

    num += BigInt(b) << BigInt(shift)
    shift += 8
  }

  return isNeg ? -num : num
}

function decodeNumberOrBigInt(buf: Buffer, offset: number, numBytes: number, isNeg: boolean): number | BigInt {
  // const negative = numBytesOrNeg < 0
  // const numBytes = Math.abs(numBytesOrNeg)

  let num = 0
  let mult = 1
  for (let i = numBytes-1; i >= 0; --i) {
    let b = buf[offset+i]
    if (isNeg) b = -(~b & 0xff)

    num += b * mult
    mult *= 0x100
  }

  if (!Number.isSafeInteger(num)) {
    return decodeBigInt(buf, offset, numBytes, isNeg)
  }
  
  return num
}

/** Internal. Use unpack() below. */
function decode(buf: Buffer, pos: {p: number}, vsAt: number, noCanonicalize: boolean): TupleItem {
  const code = buf.readUInt8(pos.p++) as Code
  let {p} = pos

  switch (code) {
    case Code.Null: return null
    case Code.False: return false
    case Code.True: return true
    case Code.Bytes: case Code.String: {
      const builder = new BufferBuilder()
      for (; p < buf.length; p++) {
        const byte = buf[p]
        if (byte === 0) {
          if (p+1 >= buf.length || buf[p+1] !== 0xff) break
          else p++ // skip 0xff.
        }
        builder.appendByte(byte)
      }
      pos.p = p + 1 // eat trailing 0
      return code === Code.Bytes ? builder.make() : builder.make().toString()
    }
    case Code.Nested: {
      const result: TupleItem[] = []
      while (true) {
        if (buf[pos.p] === 0) {
          if (pos.p+1 >= buf.length || buf[pos.p+1] !== 0xff) break
          else {
            pos.p += 2
            result.push(null)
          }
        } else result.push(decode(buf, pos, vsAt, noCanonicalize))
      }
      pos.p++ // Eat trailing 0.
      return result
    }
    case Code.Double: {
      const numBuf = Buffer.alloc(8)
      buf.copy(numBuf, 0, p, p+8)
      adjustFloat(numBuf, false)
      pos.p += 8

      // In canonical mode we wrap all doubles & floats so that when you re-
      // encode them they don't get confused with other numeric types.

      // Also buffer.readDoubleBE canonicalizes all NaNs to the same NaN
      // value. This is usually fine, but it means unpack(pack(val)) is
      // sometimes not bit-identical. There's also some canonicalization of
      // other funky float values. We need to avoid all of that to make the
      // bindingtester pass - which is a bit unnecessarily exhausting; but
      // fine. To solve this I'm storing the raw encoding so we can copy that
      // back in encode().
      const value = numBuf.readDoubleBE(0)
      // console.log('tuple decode double', numBuf, value)
      return noCanonicalize
        ? {type: 'double', value, rawEncoding: numBuf}
        : value
    }
    case Code.Float: {
      const numBuf = Buffer.alloc(4)
      buf.copy(numBuf, 0, p, p+4)
      adjustFloat(numBuf, false)
      pos.p += 4

      const value = numBuf.readFloatBE(0)
      // console.log('tuple decode float', numBuf, value)
      return noCanonicalize
        ? {type: 'float', value, rawEncoding: numBuf}
        : value
    }
    case Code.UUID: {
      const value = Buffer.alloc(16)
      buf.copy(value, 0, p, p+16)
      pos.p += 16
      return {type: 'uuid', value}
    }
    case Code.Versionstamp: {
      pos.p += 12
      if (vsAt === p || !buf.compare(UNSET_TR_VERSION, 0, 10, p, p+10)) {
        // Its unbound. Decode as-is. I'm not sure when this will come up in
        // practice, but it means pack and unpack are absolute inverses of one
        // another.

        // This logic is copied from the python bindings. But I'm
        // confused why they still keep the code even when its unbound.
        return {type: 'unbound versionstamp', code: buf.readUInt16BE(p+10)}
        // return {type: 'unbound versionstamp'}
      }
      else {
        const value = Buffer.alloc(12)
        buf.copy(value, 0, p, p+12)
        return {type: 'versionstamp', value}

        // return value.compare(UNSET_TR_VERSION, 0, 10, 0, 10)
        //   ? {type: 'versionstamp', value}
        //   : {type: 'unbound versionstamp', code: value.readUInt16BE(10)}
      }
    }
    default: {
      if (code > Code.NegIntStart && code < Code.PosIntEnd) {
        const byteLen = code-20 // negative if number is negative.
        const absByteLen = Math.abs(byteLen)
        pos.p += absByteLen
        if (code === Code.IntZero) return 0
        else if (absByteLen <= 7) {
          // Try to decode as a number - but we'll bump it to a BigInt if the
          // number falls outside the safe range.
          return decodeNumberOrBigInt(buf, p, absByteLen, byteLen < 0)
        } else {
          return decodeBigInt(buf, p, absByteLen, byteLen < 0)
        }
      } else if (code === Code.NegIntStart || code === Code.PosIntEnd) {
        const isNeg = code === Code.NegIntStart
        let len = buf[p++]
        if (isNeg) len ^= 0xff
        pos.p = p + len
        
        return decodeBigInt(buf, p, len, code === Code.NegIntStart)
      } else throw new TypeError(`Invalid tuple data: code ${code} ('${buf}' at ${pos})`);
    }
  }
}

// For debugging.
export const name = 'tuple'

// TODO: Consider a bound version of this method.
/**
 * Unpack a buffer containing a tuple back into its constituent elements.
 * 
 * This is the inverse of `pack()`, so unpack(pack(x)) == x.
 *
 * @param buf The buffer containing the tuple data to decode.
 *
 * @param noCanonicalize Pass true here to force the decoder to decode IEEE
 * floatingpoint numbers to `{type:'float' / 'double', val:...}` rather than
 * simply using javascript values. This allows you to tell how a number embedded
 * in a tuple was encoded. Most users will never use this option.
 */
export function unpack(buf: Buffer, noCanonicalize: boolean = false) {
  const pos = {p: 0}
  const arr: TupleItem[] = []

  while(pos.p < buf.length) {
    arr.push(decode(buf, pos, -1, noCanonicalize))
  }

  return arr
}

// export function unpack(key: Buffer | UnboundStamp, noCanonicalize: boolean = false) {
//   const pos = {p: 0}
//   const arr: TupleItem[] = []

//   const isUnbound = isPackUnbound(key)
//   const buf: Buffer = isUnbound ? (key as UnboundStamp).data : (key as Buffer)
//   const vsAt = isUnbound ? (key as UnboundStamp).stampPos : -1

//   while(pos.p < buf.length) {
//     arr.push(decode(buf, pos, vsAt, noCanonicalize))
//   }

//   return arr
// }

/**
 * Get the start and end of the range containing all tuples which have the
 * passed tuple as a prefix.
 */
export function range(arr: TupleItem | TupleItem[]) {
  var packed = pack(arr)

  return {
    begin: concat2(packed, rawRange.begin),
    end: concat2(packed, rawRange.end),
  }
}

const vsFrom = (versionstamp: Buffer, code: number): Buffer => {
  const result = Buffer.alloc(12)
  versionstamp.copy(result)
  result.writeUInt16BE(code, 10)
  return result
}

// TODO: Consider moving this into node-foundationdb proper.
export function bakeVersionstamp(val: TupleItem[], versionstamp: Buffer, codeBytes: Buffer | null) {
  // This is called after a transaction has been committed to bake in the (now
  // known) versionstamp into the tuple.
  for (let i = 0; i < val.length; i++) {
    const v = val[i]
    if (Array.isArray(v)) bakeVersionstamp(v, versionstamp, codeBytes)
    else if (v != null && typeof v === 'object' && !Buffer.isBuffer(v) && !isBigInt(v) && v.type === 'unbound versionstamp') {
      // ^-- gross
      if (codeBytes == null && v.code == null) {
        throw Error('Internal consistency error: unknown versionstamp code in bakeVersion. This should never happen - file a bug')
      }

      val[i] = {
        type: 'versionstamp',
        value: codeBytes ? concat2(versionstamp, codeBytes) : vsFrom(versionstamp, v.code!)
      }
    }
  }
}
