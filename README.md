# Foundationdb tuple encoder

This is an encoder and decoder for the foundationdb [tuple encoding](https://apple.github.io/foundationdb/data-modeling.html#tuples) format.

```
npm install --save fdb-tuple
```

then:

```javascript
const tuple = require('fdb-tuple')

const packed = tuple.pack(['hi', 'there']) // <Buffer 02 68 69 00 02 74 68 65 72 65 00>

console.log(tuple.unpack(packed))
// Prints [ 'hi', 'there' ] !
```

The tuple encoding format is a dynamically typed binary format. Its kind of like JSON, but its binary and it doesn't support associative objects. The format has some distinct advantages compared to json / [msgpack](https://msgpack.org/index.html) when encoding the keys of a key-value database like foundationdb. (See below)

This format is not specific to foundationdb. It can be used in lots of other places in place of other encoding methods.

The spec for the encoding format itself is [documented here](https://github.com/apple/foundationdb/blob/master/design/tuple.md).

This library has no dependancies and can be embedded in lots of places, but unfortunately for historical reasons its written against nodejs buffers. The [DataView](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DataView) API would be a better fit - because that would allow it to be used in browser contexts too. Please file an issue if you care about this - if nobody makes noise I may never get around to making that change.


## Why use tuple encoding when JSON / msgpack / BSON etc already exist?

FDB tuples are the recommended way to encode keys in foundationdb because tuples carry some important benefits compared to using JSON (or any other encoding method):

- Every tuple has a canonical byte encoding. JSON allows many ways for the same object can be converted to bytes. (For example, an object's keys can be reordered). So you might store a value with a key, then later be unable to fetch or update your value if your JSON encoder arbitrarily changes which bytes it uses to represent your key.
- The tuple encoding format is a binary format - so keys become smaller than they would with JSON. This can be quite important when you have a lot of small objects in your database.
- The bytes produced by the tuple encoder are ordered based on how the encoded items themselves are ordered. For example, the bytes used to store tuples containing `0`, `2`, `10` preserves that order. (JSON gives you `0`, `10`, `2` instead). This enables range read methods to work correctly.
- The tuple encoder has the property that pack(concat(a, b)) == concat(pack(a), pack(b)). This makes dealing with prefixes much easier, because key prefixes can be naively concatenated. For example in fdb, `db.at(['x']).get(['y'])` and `db.get(['x', 'y'])` are equivalent.
- Unlike JSON, FDB tuples natively support bigints (up to 255 bytes) and byte arrays
- The tuple encoder allows special versionstamp placeholders to be embedded, which (on save) are replaced with information about the committed database version. See [node-foundationdb documentation](https://github.com/josephg/node-foundationdb#2-using-versionstamps-with-the-tuple-layer) on how to use this.

FDB tuples are interoperable with the bindings in other languages - but the tuple type certainly wasn't designed with specifically javascript in mind. Weaknesses compared to using JSON:

- The tuple encoder does not support javascript objects or maps
- Because tuples are a binary format, they aren't human readable.
- The types for numbers don't really match up to native javascript number types. (See below.)
- The tuple encoder has no concept of a 'bare' value. A tuple value is always an array, even if that array only contains 1 element.

## JS to Tuple value mapping

| JS value | Example | Encoding format | Note |
| -- | -- | -- | -- |
| null | null | null (0) | |
| Boolean | true / false | True / False  | |
| string | 'hi', 'Rad ⛄️' | Unicode string | 1 |
| Buffer | `Buffer.from([1,2,3])` | Byte string | |
| Child array | \[1, \['hi', 'ho'\], 3\] | Nested tuple | |
| Safe JS integers (where \|x\| < 2**53) | 17, -3 | Integer | |
| Non-integers | 4.7, Math.PI | IEEE Double | |
| Numbers outside the JS safe range | Math.E ** 300 | IEEE Double | 2 |
| BigInts up to 255 bytes | -3n, 2n ** 256n | Integer | 3 |
| `{type:'float', value:__}` | `{type:'float', value:13}` | IEEE Float | 4 |
| `{type:'double', value:__}` | `{type:'double', value:13}` | IEEE Double | 4 |
| `{type:'versionstamp', value:Buffer}` | `{type:'versionstamp', value:Buffer.from(...)}` | 96 Bit Versionstamp | 5 |
| `tuple.unboundVersionstamp()` | `tuple.unboundVersionstamp()` | 96 Bit Versionstamp | 6 |
| Object | {} | **not supported** | |

#### Notes:

1. All JS strings are encoded using the tuple unicode format, even if all characters are ASCII.
2. 💣 Everything outside the safe range is encoded to a double - even integers outside the safe range.
3. Bigints larger than 255 bytes are not supported. Also 💣 **Danger**: The tuple wire format doesn't differentiate between a bigint and any other integer. As a result, `3n` encodes to the same bytes as `3`. Any bigints you encode within the safe integer range will be decoded back into normal javascript numbers.
4. These formats are provided to force IEEE float or double encoding of a number. This can be useful when you need compatibility with other bindings. Or if you're mixing integers and non-integers in keys, and want getRange() to work correctly. (See below.
5. Used by set/get versionstamp methods
6. Placeholder for a versionstamp for use with `tn.setVersionstampedKey()` / `tn.setVersionstampedValue()` methods. The placeholder will be replaced with the actual versionstamp when the transaction is committed. A tuple can recursively only contain 1 unbound versionstamp.


The details of how JS numbers map to tuple numbers is a bit of a mess:

*Danger 💣:* If you mix integers and floats in your database keys, getRange will not work correctly. The tuple encoding sorts *all* integers before *all* floating point numbers. So if your values have keys `[0.9]`, `[1]`, `[1.1]`, your keys will sort in the wrong order (you'll get `[1]`, `[0.9]`, `[1.1]`). And if you call `tn.getRange([0], [2])`, you will only get `[1]`. You can force the tuple encoder to always use floating point encoding for integers by wrapping the number in an object: `pack([{type: 'double', value: 1}, ...])` instead of `pack([1, ...])`.

*More Danger 💣:* The encoding for bigints will not preserve the bigint-ness of a number. unpack(pack(\[3n\])) === \[3\] not \[3n\]. This is only a problem for safe JS integers. Any integer larger than 2^53 (or smaller than -2^53) will decode to a bigint automatically.



You can also encode and decode values directly using `tuple.pack` and `tuple.unpack` methods of the API:

```javascript
const tuple = require('fdb-tuple')
const packed = tuple.pack(['hi', 'there']) // <Buffer 02 68 69 00 02 74 68 65 72 65 00>
console.log(tuple.unpack(packed)) // [ 'hi', 'there' ]
```

If you just want to tuple encode a single value, you don't need to wrap it in an array. Unless `x` is an array, `tuple.pack(x)` == `tuple.pack([x])`. (But note that `tuple.pack([[x]])` != `tuple.pack([x])`!)


## API

There are a fair few methods inside the library, but pack and unpack should cover 99% of uses. Pack and unpack are basically equivalent to JSON.stringify and JSON.parse.

### tuple.pack(val: TupleItem | TupleItem[]) -> Buffer

Pack the specified value into a buffer. The buffer is returned.

```javascript
const tuple = require('fdb-tuple')
const packed = tuple.pack(['hi', 3, Buffer.from([1,2,3]), ['embedded']])
// packed is <Buffer 02 68 69 00 15 03 01 01 02 03 00 05 02 65 6d 62 65 64 64 65 64 00 00>
```

If you're encoding a single item, you don't need to wrap it in an array. The array-wrapping is implicit. This makes your code easier to read and slightly faster.

```javascript
const tuple = require('fdb-tuple')
const a = tuple.pack('💃')   // <Buffer 02 f0 9f 92 83 00>
const b = tuple.pack(['💃']) // <Buffer 02 f0 9f 92 83 00>

assert.deepStrictEqual(a, b) // ok
```

Val must be a valid tuple item, or an array of tuple items.

Valid tuple items are:

- `true`, `false`
- `null`
- strings (incl any unicode character)
- numbers
- Node `Buffer`s
- bigints up to 255 bytes long
- Child arrays containing more tuple items
- `{type:'float', val:(number)}` or `{type:'double', val:(number)}`, used to force the specified number to be encoded as a float or double.
- A versionstamp or unbound versionstamp.

Invalid tuple items:

- Objects, or instances of classes
- `undefined`

### tuple.unpack(val: Buffer, [noCanonicalize: bool]) -> TupleItem[]

Unpack the tuple contained in the passed buffer back into an array of elements. The array is returned.

This method throws an exception if the buffer does not contain a valid tuple.

The noCanonicalize argument makes the decoder wrap all float / doubles in an object, like `{type:'float', val:123}`. This lets you ensure that if you re-pack the tuple, you'll produce exactly the same bytes you started with. Most people will never use this option.