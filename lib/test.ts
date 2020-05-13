import 'mocha'
import assert = require('assert')

import {TupleItem} from '.'
import * as tuple from '.'

const floatBytes = (x: number) => {
  const result = Buffer.alloc(4)
  result.writeFloatBE(x, 0)
  return result
}

describe('tuple', () => {
  const assertRoundTripBytes = (orig: Buffer, strict: boolean = false) => {
    const val = tuple.unpack(orig, strict)[0] as TupleItem
    const packed = tuple.pack([val])
    // console.log(orig.toString('hex'), val, packed.toString('hex'))
    assert.deepStrictEqual(packed, orig)
  }
  const assertEncodesAs = (value: TupleItem, data: Buffer | string | number[]) => {
    const encoded = tuple.pack([value])
    let bytes = Buffer.isBuffer(data) ? data
      : typeof data === 'string' ? Buffer.from(data, 'ascii')
      : Buffer.from(data)
    assert.deepStrictEqual(encoded, bytes)

    // Check that numbered int -> bigint has no effect on encoded output.
    if (typeof value === 'number' && Number.isInteger(value)) {
      const encoded2 = tuple.pack([BigInt(value)])
      assert.deepStrictEqual(encoded2, bytes, 'Value encoded differently with bigint encoder')
    }

    const decoded = tuple.unpack(encoded)
    // Node 8
    if (typeof value === 'number' && isNaN(value as number)) assert(isNaN(decoded[0] as number))
    else assert.deepStrictEqual(decoded, [value])
  }

  describe('roundtrips expected values', () => {
    const assertRoundTrip = (val: TupleItem, strict: boolean = false) => it(typeof val === 'bigint' ? `${val}n` : JSON.stringify(val), () => {
      // const packed = tuple.pack([val])
      const packed = tuple.pack([val])
      if (!Array.isArray(val)) {
        const packedRaw = tuple.pack(val)
        assert.deepStrictEqual(packed, packedRaw)
      }
  
      const unpacked = tuple.unpack(packed, strict)[0]
      assert.deepStrictEqual(unpacked, val)
  
      // Check that numbered int -> bigint has no effect on encoded output.
      if (typeof val === 'number' && Number.isSafeInteger(val)) {
        const packed2 = tuple.pack([BigInt(val)])
        assert.deepStrictEqual(packed2, packed, 'Value encoded differently with bigint encoder')
      }
    })

    const data = ['hi', null, '👾', 321, 0, -100]
    assertRoundTrip(data)

    assertRoundTrip(0.75)
    assertRoundTrip(BigInt('12341234123412341234'))
    assertRoundTrip(BigInt('-12341234123412341234'))
    // This is a 230-byte number.
    assertRoundTrip(BigInt('-25590177972831273370257770873989184378968622566250081269954042898433662370031719667203350964691861270342483438771650473254888465056727193237251538125410415669915254450681177531095961100324827856201637570233530243472179104778438087224216101130117197440338289639344554123323256917100155477022101041486896307697849188764471017736123757252639610971416446462793453318430443692386602432742205109597722547740645132051736817382305630442267915356539282325495631800602625500347541220888685499019574296692446821077084703673346449833537043377925515781584311410015431'))


    assertRoundTrip(Number.MAX_SAFE_INTEGER)
    assertRoundTrip(Number.MAX_SAFE_INTEGER + 1) // Encoded as a double.
    assertRoundTrip(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)) // Encoded as an integer

    assertRoundTrip(-Number.MAX_SAFE_INTEGER)
    assertRoundTrip(-Number.MAX_SAFE_INTEGER - 1)
    assertRoundTrip(-BigInt(Number.MAX_SAFE_INTEGER) - BigInt(1))

    assertRoundTrip({type: 'float', value: 0.5, rawEncoding:floatBytes(0.5)}, true)
  })

  it('handles negative bigint numbers correctly', () => { // regression
    const bytes = Buffer.from('\x0b\x19\xac\x9b\xcdf;\xe9\x08\xa9\xfc\x17\x06hE^4}'
      + '\xc7\xbc\xfe\xa9\x9997\x90\xdb\xdf\tD\xc4\xd1\xfc\xdc\x934\xf5\xa8\xe23>E'
      + '\x94\xf8\xd2)\x1fz\x94QO\xf0\x01\xe6pza,\x81\x05us=\xd6\xc7\xa3\xaa\xd1R'
      + '\xf8j\xdd\xb0\xaa\x03lW\xb7\xd3\xf5\x84\x7ff\xbb\xb31\xc8\xcf\xb7gpg\x18'
      + '\x11\xa7\x9b6\xaa\xd7\xe3\x82\x8dM\xf7\xf3\xda\xe8\xac\xeb\xb8\xfd\xce\xae'
      + '\xf2[Z\r?\xd7@\x03\xf8c\xdb\xd6q\xac\xfe\xfe\xcb\xfa\x17\xde\x08\xb9\xe5K'
      + '\x81\xad\xdf\xe7\xd9\x10\x12\xb0L\xa1\x15c\x0e\xc3\xda\xd2;\xbc.\xcdo\xc9'
      + '1/-\xf6\xf1\xfajW\xd1\xa5\xaa\xbf\xda\xfel\xde\x84\xe9~\xc5\xe7\xe7}\xe1'
      + '\x96\xc3\x91\xaf\x8eQQz\xd4\xff\x94i\xc3\xe8\xc0\xb3\xa0"\xd6\xe26\xee\x0b'
      + '\x05&\x9d\x95\x19)q}\x02$4\xa8\xf61\x07i\x89\xa3&\x82\x89\xaf=\x17C8', 'ascii')

    const expected = BigInt('-25590177972831273370257770873989184378968622566250081'
      + '26995404289843366237003171966720335096469186127034248343877165047325488846'
      + '50567271932372515381254104156699152544506811775310959611003248278562016375'
      + '70233530243472179104778438087224216101130117197440338289639344554123323256'
      + '91710015547702210104148689630769784918876447101773612375725263961097141644'
      + '64627934533184304436923866024327422051095977225477406451320517368173823056'
      + '30442267915356539282325495631800602625500347541220888685499019574296692446'
      + '821077084703673346449833537043377925515781584311410015431')
    
    assertEncodesAs(expected, bytes)
  })

  it('handles null and undefined as expected', () => {
    assert.deepStrictEqual(tuple.pack(null), Buffer.from([0]))
    assert.deepStrictEqual(tuple.pack(undefined), Buffer.from([]))
    assert.deepStrictEqual(tuple.pack([]), Buffer.from([]))

    assert.throws(() => {
      tuple.pack([undefined as any])
    })
  })

  it('implements bigint encoding in a way that matches the java bindings', () => {
    // These are ported from here:
    // https://github.com/apple/foundationdb/blob/becc01923a30c1bc2ba158b293dbb38de7585c72/bindings/java/src/test/com/apple/foundationdb/test/TupleTest.java#L109-L122
    assertEncodesAs(BigInt('0x7fffffffffffffff'), [0x1C, 0x7f, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    assertEncodesAs(BigInt('0x8000000000000000'), [0x1C, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    assertEncodesAs(BigInt('0xffffffffffffffff'), [0x1C, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    assertEncodesAs(BigInt('0x10000000000000000'), [0x1D, 0x09, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    assertEncodesAs(-0xffffffff, [0x10, 0x00, 0x00, 0x00, 0x00])
    assertEncodesAs(-BigInt('0x7ffffffffffffffe'), [0x0C, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01])
    assertEncodesAs(-BigInt('0x7fffffffffffffff'), [0x0C, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    assertEncodesAs(-BigInt('0x8000000000000000'), [0x0C, 0x7f, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    assertEncodesAs(-BigInt('0x8000000000000001'), [0x0C, 0x7f, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF - 1])
    assertEncodesAs(-BigInt('0xffffffffffffffff'), [0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  })

  it('throws when asked to encode a bigint larger than 255 bytes', () => {
    tuple.pack(BigInt(256) ** BigInt(254)) // should be ok

    // What about 255? That currently throws and I'm not sure if that behaviour is correct or not. TODO.

    assert.throws(() => {
      tuple.pack(BigInt(256) ** BigInt(256))
    })
  })

  it('preserves encoding of values in strict mode', () => {
    // There's a few ways NaN is encoded.
    assertRoundTripBytes(Buffer.from('210007ffffffffffff', 'hex'), true) // double
    assertRoundTripBytes(Buffer.from('21fff8000000000000', 'hex'), true)
    assertRoundTripBytes(Buffer.from('20ffc00000', 'hex'), true) // TODO: 
    assertRoundTripBytes(Buffer.from('20003fffff', 'hex'), true)
    // Do any other nan encodings exist?
    
    // Also any regular integers should be preserved.
    assertRoundTripBytes(Buffer.from('2080000000', 'hex'), true)
    assertRoundTripBytes(Buffer.from('218000000000000000', 'hex'), true)
  })

  it('preserves encoding of exotic numbers', () => {
    // I'm sure there's lots more I'm missing here.
    assertRoundTripBytes(Buffer.from('217fffffffffffffff', 'hex'), true) // This is -0.
  })

  it('stalls on invalid input', () => {
    tuple.unpack(tuple.unpack(Buffer.from('\x01\x01tester_output\x00\xff\x01workspace\x01\x00', 'ascii'))[0] as Buffer)
  })
      
  describe('Conformance tests', () => {
    // These are from the examples here:
    // https://github.com/apple/foundationdb/blob/master/design/tuple.md

    const testConformance = (name: string, value: TupleItem, bytes: Buffer | string) => {
      it(name, () => assertEncodesAs(value, bytes))
    }

    testConformance('null', null, '\x00')
    testConformance('false', false, '\x26')
    testConformance('true', true, '\x27')
    testConformance('bytes', Buffer.from('foo\x00bar', 'ascii'), '\x01foo\x00\xffbar\x00')
    testConformance('string', "F\u00d4O\u0000bar", '\x02F\xc3\x94O\x00\xffbar\x00')
    // TODO: Nested tuple
    testConformance('nested tuples',
      [Buffer.from('foo\x00bar', 'ascii'), null, []],
      '\x05\x01foo\x00\xffbar\x00\x00\xff\x05\x00\x00'
    )
    testConformance('zero', 0, '\x14') // zero
    testConformance('integer', -5551212, '\x11\xabK\x93') // integer
    // testConformance(-42.
    // testConformance('nan float', NaN, Buffer.from('0007ffffffffffff', 'hex')
    testConformance('nan double', NaN, Buffer.from('21fff8000000000000', 'hex'))
    testConformance('bound version stamp',
      {type: 'versionstamp', value: Buffer.alloc(12).fill(0xe3)},
      Buffer.from('33e3e3e3e3e3e3e3e3e3e3e3e3', 'hex')
    )
    // TODO: unbound versionstamps
  })
})