// RSABSSA-SHA384-PSS-Deterministic, RFC 9474: RSA blind signatures with EMSA-PSS (SHA-384, MGF1-SHA-384,
// 48-byte salt) and no message randomizer. Client side only: blind, finalize (unblind + verify) and
// public verification. Pure TS (BigInt + @noble/hashes), no node:* and no WebCrypto.

import { sha384 } from "@noble/hashes/sha2.js";
import { bigIntToBytes, bitLength, bytesToBigInt, mod, modinv, modpow } from "./bigint";
import { bytesEqual, concatBytes } from "./bytes";
import { defaultGetRandomBytes, type GetRandomBytes } from "./random";

export const HASH_LENGTH = 48;
export const SALT_LENGTH = 48;

export interface RsaPublicKey {
  n: bigint;
  e: bigint;
}

/** Test/vector hooks: fixed salt and fixed blinding inverse (as published in the RFC test vectors). */
export interface BlindHooks {
  getRandomBytes?: GetRandomBytes;
  salt?: Uint8Array;
  /** The blinding inverse `inv` (r^-1 mod n); the blinding factor is r = inv^-1 mod n. */
  inv?: Uint8Array;
}

export interface BlindResult {
  blindedMsg: Uint8Array;
  /** Secret, needed by finalize. */
  inv: Uint8Array;
}

export const modulusBytes = (pk: RsaPublicKey): number => Math.ceil(bitLength(pk.n) / 8);

/** MGF1 (RFC 8017 appendix B.2.1) with SHA-384. */
export function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(length / HASH_LENGTH) * HASH_LENGTH);
  for (let counter = 0; counter * HASH_LENGTH < length; counter += 1) {
    const c = new Uint8Array([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]);
    out.set(sha384(concatBytes(seed, c)), counter * HASH_LENGTH);
  }
  return out.subarray(0, length);
}

/** EMSA-PSS-ENCODE (RFC 8017 section 9.1.1) with SHA-384, MGF1-SHA-384 and a caller supplied 48-byte salt. */
export function emsaPssEncode(msg: Uint8Array, emBits: number, salt: Uint8Array): Uint8Array {
  if (salt.length !== SALT_LENGTH) throw new Error("salt must be 48 bytes");
  const emLen = Math.ceil(emBits / 8);
  if (emLen < HASH_LENGTH + SALT_LENGTH + 2) throw new Error("encoding error: modulus too small");
  const mHash = sha384(msg);
  const h = sha384(concatBytes(new Uint8Array(8), mHash, salt));
  const db = new Uint8Array(emLen - HASH_LENGTH - 1);
  db[db.length - SALT_LENGTH - 1] = 0x01;
  db.set(salt, db.length - SALT_LENGTH);
  const dbMask = mgf1(h, db.length);
  for (let i = 0; i < db.length; i += 1) db[i] = db[i]! ^ dbMask[i]!;
  db[0] = db[0]! & (0xff >> (8 * emLen - emBits));
  return concatBytes(db, h, new Uint8Array([0xbc]));
}

/** EMSA-PSS-VERIFY (RFC 8017 section 9.1.2) with SHA-384, MGF1-SHA-384, 48-byte salt. */
export function emsaPssVerify(msg: Uint8Array, em: Uint8Array, emBits: number): boolean {
  const emLen = Math.ceil(emBits / 8);
  if (em.length !== emLen || emLen < HASH_LENGTH + SALT_LENGTH + 2) return false;
  if (em[emLen - 1] !== 0xbc) return false;
  const dbLen = emLen - HASH_LENGTH - 1;
  const maskedDb = em.subarray(0, dbLen);
  const h = em.subarray(dbLen, dbLen + HASH_LENGTH);
  const topMask = 0xff >> (8 * emLen - emBits);
  if ((maskedDb[0]! & ~topMask & 0xff) !== 0) return false;
  const dbMask = mgf1(h, dbLen);
  const db = new Uint8Array(dbLen);
  for (let i = 0; i < dbLen; i += 1) db[i] = maskedDb[i]! ^ dbMask[i]!;
  db[0] = db[0]! & topMask;
  const psLen = dbLen - SALT_LENGTH - 1;
  for (let i = 0; i < psLen; i += 1) if (db[i] !== 0) return false;
  if (db[psLen] !== 0x01) return false;
  const salt = db.subarray(psLen + 1);
  const expected = sha384(concatBytes(new Uint8Array(8), sha384(msg), salt));
  return bytesEqual(expected, h);
}

/** RFC 9474 section 4.2 Blind. */
export function blind(pk: RsaPublicKey, msg: Uint8Array, hooks: BlindHooks = {}): BlindResult {
  const getRandomBytes = hooks.getRandomBytes ?? defaultGetRandomBytes;
  const kLen = modulusBytes(pk);
  const emBits = bitLength(pk.n) - 1;
  const salt = hooks.salt ?? getRandomBytes(SALT_LENGTH);
  const m = bytesToBigInt(emsaPssEncode(msg, emBits, salt));

  let r: bigint;
  let inv: bigint;
  if (hooks.inv) {
    if (modinv(m, pk.n) === null) throw new Error("invalid input");
    inv = bytesToBigInt(hooks.inv);
    const rr = modinv(inv, pk.n);
    if (rr === null) throw new Error("blinding error");
    r = rr;
  } else {
    // kLen + 16 random bytes reduced mod n: bias below 2^-128. Retry on the (negligible) non-invertible draw.
    // One inversion per ticket instead of two (the dominant cost on Hermes, PERF-TIME-03): (m*r)^-1 exists iff both
    // m^-1 and r^-1 do, and then r^-1 = m * (m*r)^-1. Only a failed product inversion pays the separate m check.
    for (;;) {
      const candidate = mod(bytesToBigInt(getRandomBytes(kLen + 16)), pk.n);
      if (candidate === 0n) continue;
      const productInv = modinv((m * candidate) % pk.n, pk.n);
      if (productInv !== null) {
        r = candidate;
        inv = (m * productInv) % pk.n;
        break;
      }
      if (modinv(m, pk.n) === null) throw new Error("invalid input");
    }
  }
  const z = (m * modpow(r, pk.e, pk.n)) % pk.n;
  return { blindedMsg: bigIntToBytes(z, kLen), inv: bigIntToBytes(inv, kLen) };
}

/** RSASSA-PSS-VERIFY (RFC 8017 section 8.1.2) with the RFC 9474 parameters. */
export function verify(pk: RsaPublicKey, msg: Uint8Array, sig: Uint8Array): boolean {
  const kLen = modulusBytes(pk);
  if (sig.length !== kLen) return false;
  const s = bytesToBigInt(sig);
  if (s >= pk.n) return false;
  const m = modpow(s, pk.e, pk.n);
  const emBits = bitLength(pk.n) - 1;
  const emLen = Math.ceil(emBits / 8);
  let em: Uint8Array;
  try {
    em = bigIntToBytes(m, emLen);
  } catch {
    return false;
  }
  return emsaPssVerify(msg, em, emBits);
}

/** RFC 9474 section 4.4 Finalize: unblind and verify; throws when the signature does not verify. */
export function finalize(pk: RsaPublicKey, msg: Uint8Array, blindSig: Uint8Array, inv: Uint8Array): Uint8Array {
  const kLen = modulusBytes(pk);
  if (blindSig.length !== kLen) throw new Error("unexpected input size");
  const z = bytesToBigInt(blindSig);
  if (z >= pk.n) throw new Error("unexpected input size");
  const sig = bigIntToBytes((z * bytesToBigInt(inv)) % pk.n, kLen);
  if (!verify(pk, msg, sig)) throw new Error("invalid signature");
  return sig;
}
