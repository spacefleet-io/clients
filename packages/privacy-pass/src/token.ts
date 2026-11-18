// Privacy Pass token codec, RFC 9578 token type 0x0002 (publicly verifiable, RSA-2048 blind signatures),
// carried in the RFC 9577 `Authorization: PrivateToken token="..."` header. Pure TS, no node:*.

import { sha256 } from "@noble/hashes/sha2.js";
import { bigIntToBytes } from "./bigint";
import { asciiToBytes, base64UrlToBytes, bytesEqual, bytesToBase64Url, concatBytes } from "./bytes";

export const TOKEN_TYPE = 0x0002;
/** RSA public exponent: always 65537, so apps pin only the modulus. */
export const TOKEN_PUBLIC_EXPONENT = 65537n;
export const ISSUER_NAME = "metadata.spacefleet.io";

export const NONCE_LENGTH = 32;
export const CHALLENGE_DIGEST_LENGTH = 32;
export const KEY_ID_LENGTH = 32;
export const AUTHENTICATOR_LENGTH = 256;
export const TOKEN_LENGTH = 2 + NONCE_LENGTH + CHALLENGE_DIGEST_LENGTH + KEY_ID_LENGTH + AUTHENTICATOR_LENGTH;
export const AUTHORIZATION_SCHEME = "PrivateToken";

const tokenTypeBytes = new Uint8Array([(TOKEN_TYPE >> 8) & 0xff, TOKEN_TYPE & 0xff]);

/**
 * TokenChallenge (RFC 9577 section 2.1), the same for everyone:
 * token_type(2) || issuer_name<1..2^16-1> || redemption_context<0..32> (empty) || origin_info<0..2^16-1> (empty).
 */
export const TOKEN_CHALLENGE: Uint8Array = (() => {
  const issuer = asciiToBytes(ISSUER_NAME);
  return concatBytes(tokenTypeBytes, new Uint8Array([(issuer.length >> 8) & 0xff, issuer.length & 0xff]), issuer, new Uint8Array([0]), new Uint8Array([0, 0]));
})();

/** SHA-256(TokenChallenge). */
export const CHALLENGE_DIGEST: Uint8Array = sha256(TOKEN_CHALLENGE);

// --- DER (just enough to build the RSASSA-PSS SubjectPublicKeyInfo of RFC 9578 section 6.5) ---

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return new Uint8Array([length]);
  if (length < 0x100) return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff]);
};
const der = (tag: number, ...body: Uint8Array[]): Uint8Array => {
  const content = concatBytes(...body);
  return concatBytes(new Uint8Array([tag]), derLength(content.length), content);
};
const derUnsignedInteger = (value: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return der(0x02, trimmed[0]! & 0x80 ? concatBytes(new Uint8Array([0]), trimmed) : trimmed);
};
const OID_RSASSA_PSS = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a]);
const OID_MGF1 = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08]);
const OID_SHA384 = new Uint8Array([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02]);

/**
 * DER SubjectPublicKeyInfo of an RSASSA-PSS public key (SHA-384, MGF1-SHA-384, saltLength 48, e = 65537),
 * byte for byte what RFC 9578 section 6.5 hashes into token_key_id.
 */
export function rsaPssSpki(modulus: Uint8Array): Uint8Array {
  const sha384Id = der(0x30, OID_SHA384);
  const params = der(
    0x30,
    der(0xa0, sha384Id),
    der(0xa1, der(0x30, OID_MGF1, sha384Id)),
    der(0xa2, der(0x02, new Uint8Array([48]))),
  );
  const rsaPublicKey = der(0x30, derUnsignedInteger(modulus), derUnsignedInteger(bigIntToBytes(TOKEN_PUBLIC_EXPONENT, 3)));
  return der(0x30, der(0x30, OID_RSASSA_PSS, params), der(0x03, new Uint8Array([0]), rsaPublicKey));
}

/** token_key_id = SHA-256(DER SubjectPublicKeyInfo). */
export const keyIdOfSpki = (spkiDer: Uint8Array): Uint8Array => sha256(spkiDer);

/** token_key_id for the RSA modulus (big-endian bytes), with e = 65537. */
export const keyIdOfModulus = (modulus: Uint8Array): Uint8Array => keyIdOfSpki(rsaPssSpki(modulus));

// --- token ---

/** token_type || nonce || challenge_digest || token_key_id: what the RSABSSA signature covers. */
export function tokenAuthenticatorInput(nonce: Uint8Array, keyId: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_LENGTH) throw new Error("nonce must be 32 bytes");
  if (keyId.length !== KEY_ID_LENGTH) throw new Error("token_key_id must be 32 bytes");
  return concatBytes(tokenTypeBytes, nonce, CHALLENGE_DIGEST, keyId);
}

export interface ParsedToken {
  tokenType: number;
  nonce: Uint8Array;
  challengeDigest: Uint8Array;
  keyId: Uint8Array;
  authenticator: Uint8Array;
  /** The bytes the authenticator signs. */
  authenticatorInput: Uint8Array;
}

export function buildToken(nonce: Uint8Array, keyId: Uint8Array, authenticator: Uint8Array): Uint8Array {
  if (authenticator.length !== AUTHENTICATOR_LENGTH) throw new Error("authenticator must be 256 bytes");
  return concatBytes(tokenAuthenticatorInput(nonce, keyId), authenticator);
}

/** Splits a 354-byte token; null when the length is wrong. Type and digest are reported, not judged here. */
export function parseToken(token: Uint8Array): ParsedToken | null {
  if (token.length !== TOKEN_LENGTH) return null;
  let offset = 0;
  const take = (length: number) => {
    const part = token.subarray(offset, offset + length);
    offset += length;
    return part;
  };
  const type = take(2);
  const nonce = take(NONCE_LENGTH);
  const challengeDigest = take(CHALLENGE_DIGEST_LENGTH);
  const keyId = take(KEY_ID_LENGTH);
  const authenticator = take(AUTHENTICATOR_LENGTH);
  return {
    tokenType: (type[0]! << 8) | type[1]!,
    nonce,
    challengeDigest,
    keyId,
    authenticator,
    authenticatorInput: token.subarray(0, 2 + NONCE_LENGTH + CHALLENGE_DIGEST_LENGTH + KEY_ID_LENGTH),
  };
}

/** True when the token has the right length, type 0x0002 and the fixed challenge digest. */
export function hasExpectedChallenge(parsed: ParsedToken): boolean {
  return parsed.tokenType === TOKEN_TYPE && bytesEqual(parsed.challengeDigest, CHALLENGE_DIGEST);
}

/** `PrivateToken token="<base64url token>"` (RFC 9577 section 2.2), the value of the Authorization header. */
export function privateTokenAuthorization(token: Uint8Array | string): string {
  const encoded = typeof token === "string" ? token : bytesToBase64Url(token);
  return `${AUTHORIZATION_SCHEME} token="${encoded}"`;
}

const AUTHORIZATION_RE = /^PrivateToken\s+token="([A-Za-z0-9_-]+)={0,2}"\s*$/iu;

/** Reads the token bytes out of an Authorization header value; null when it is not a well formed PrivateToken. */
export function parsePrivateTokenAuthorization(header: string | null | undefined): Uint8Array | null {
  if (!header) return null;
  const match = AUTHORIZATION_RE.exec(header);
  if (!match) return null;
  try {
    return base64UrlToBytes(match[1]!);
  } catch {
    return null;
  }
}
