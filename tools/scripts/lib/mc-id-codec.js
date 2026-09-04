/*
 * Decoders for Minecraft's packed NBT position/UUID formats, as used by the
 * "goml" claims mod and player profile data (Owners/Trusted UUID-int-arrays,
 * Box.OriginPos/Pos packed BlockPos longs).
 *
 * Both verified this session against real server data:
 *  - decodeUuidIntArray cross-checked against a known real player UUID
 *    (Mojang profile decode of a waypoint hub's `profile.id` field).
 *  - decodeBlockPosLong cross-checked against a claim's own "Augments" sub-position,
 *    which is stored as a plain {X,Y,Z} compound right next to the packed long
 *    for the same physical location.
 */
'use strict';

// Minecraft BlockPos.asLong() packing (1.18+): X:26 bits (shift 38), Z:26 bits (shift 12), Y:12 bits (shift 0).
// NBT stores it here as two int32s (high, low halves of the signed 64-bit long).
function decodeBlockPosLong(high, low) {
  const big = BigInt.asIntN(64, (BigInt(high) << 32n) | (BigInt(low) & 0xFFFFFFFFn));
  const X_BITS = 26n, Z_BITS = 26n, Y_BITS = 12n;
  const X_MASK = (1n << X_BITS) - 1n;
  const Z_MASK = (1n << Z_BITS) - 1n;
  const Y_MASK = (1n << Y_BITS) - 1n;
  const x = BigInt.asIntN(26, (big >> (Z_BITS + Y_BITS)) & X_MASK);
  const y = BigInt.asIntN(12, big & Y_MASK);
  const z = BigInt.asIntN(26, (big >> Y_BITS) & Z_MASK);
  return { x: Number(x), y: Number(y), z: Number(z) };
}

// Standard Minecraft UUID-as-4-ints NBT format: [msb_hi, msb_lo, lsb_hi, lsb_lo].
function decodeUuidIntArray(arr) {
  const [a, b, c, d] = arr.map(BigInt);
  const most = BigInt.asUintN(64, (a << 32n) | (b & 0xFFFFFFFFn));
  const least = BigInt.asUintN(64, (c << 32n) | (d & 0xFFFFFFFFn));
  const hex = most.toString(16).padStart(16, '0') + least.toString(16).padStart(16, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { decodeBlockPosLong, decodeUuidIntArray };
