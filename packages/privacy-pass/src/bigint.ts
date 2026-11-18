// BigInt modular arithmetic for the portable client side (RSA-2048 blind/verify). Variable-time:
// everything here operates on public values or on the client's own blinding factor, never on the
// signer's private key (that stays in node:crypto on the server).

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Big-endian, left-padded to `length`; throws when the value does not fit. */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new Error("negative integer");
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new Error("integer too large");
  return out;
}

export function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** base^exp mod m, square-and-multiply. */
export function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m <= 0n) throw new Error("modulus must be positive");
  if (exp < 0n) throw new Error("negative exponent");
  let result = 1n % m;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    if (e > 0n) b = (b * b) % m;
  }
  return result;
}

/** Modular inverse of a mod m via the extended Euclidean algorithm; null when gcd(a, m) != 1. */
export function modinv(a: bigint, m: bigint): bigint | null {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) return null;
  return mod(oldS, m);
}
