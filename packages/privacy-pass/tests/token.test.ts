import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes } from "../src/bytes";
import {
  CHALLENGE_DIGEST,
  ISSUER_NAME,
  TOKEN_CHALLENGE,
  TOKEN_LENGTH,
  buildToken,
  keyIdOfModulus,
  keyIdOfSpki,
  parsePrivateTokenAuthorization,
  parseToken,
  privateTokenAuthorization,
  rsaPssSpki,
} from "../src/token";

describe("token codec", () => {
  it("fixes the challenge bytes and digest", () => {
    console.log("[token] phase: challenge");
    expect(bytesToHex(TOKEN_CHALLENGE)).toBe(
      `0002${(ISSUER_NAME.length).toString(16).padStart(4, "0")}${Buffer.from(ISSUER_NAME).toString("hex")}000000`,
    );
    expect(bytesToHex(CHALLENGE_DIGEST)).toBe(bytesToHex(sha256(TOKEN_CHALLENGE)));
  });

  it("builds and parses 2+32+32+32+256 = 354 byte tokens", () => {
    console.log("[token] phase: build/parse");
    const nonce = new Uint8Array(32).fill(7);
    const keyId = new Uint8Array(32).fill(9);
    const authenticator = new Uint8Array(256).fill(3);
    const token = buildToken(nonce, keyId, authenticator);
    expect(TOKEN_LENGTH).toBe(354);
    expect(token.length).toBe(354);
    const parsed = parseToken(token)!;
    expect(parsed.tokenType).toBe(2);
    expect(parsed.nonce).toEqual(nonce);
    expect(parsed.challengeDigest).toEqual(CHALLENGE_DIGEST);
    expect(parsed.keyId).toEqual(keyId);
    expect(parsed.authenticator).toEqual(authenticator);
    expect(parsed.authenticatorInput.length).toBe(98);
    expect(parseToken(token.subarray(1))).toBeNull();
  });

  it("round trips base64url and refuses foreign characters", () => {
    console.log("[token] phase: base64url");
    for (const length of [0, 1, 2, 3, 4, 31, 354]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      const encoded = bytesToBase64Url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
      expect(base64UrlToBytes(encoded)).toEqual(bytes);
    }
    expect(() => base64UrlToBytes("ab+/")).toThrow();
    expect(() => base64UrlToBytes("abcde")).toThrow();
  });

  it("builds and parses the PrivateToken Authorization header", () => {
    console.log("[token] phase: header");
    const token = new Uint8Array(TOKEN_LENGTH).fill(1);
    const header = privateTokenAuthorization(token);
    expect(header).toBe(`PrivateToken token="${bytesToBase64Url(token)}"`);
    expect(parsePrivateTokenAuthorization(header)).toEqual(token);
    expect(parsePrivateTokenAuthorization(header.replace("PrivateToken", "privatetoken"))).toEqual(token);
    expect(parsePrivateTokenAuthorization("Bearer abc")).toBeNull();
    expect(parsePrivateTokenAuthorization('PrivateToken token="a b"')).toBeNull();
    expect(parsePrivateTokenAuthorization('PrivateToken token=""')).toBeNull();
    expect(parsePrivateTokenAuthorization(undefined)).toBeNull();
  });

  it("builds the RSASSA-PSS SPKI exactly as RFC 9578 section 6.5 shows it (hash AlgorithmIdentifiers without NULL)", () => {
    console.log("[token] phase: spki layout");
    const spki = rsaPssSpki(new Uint8Array(256).fill(0xab));
    // RFC 9578 section 6.5 asn1parse dump: SEQUENCE l=338, algorithm SEQUENCE l=61, rsassaPss OID, params l=48.
    const prefix = "30820152303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a2030201300382010f00";
    expect(bytesToHex(spki.subarray(0, prefix.length / 2))).toBe(prefix);
    expect(spki.length).toBe(342);
    expect(bytesToHex(keyIdOfSpki(spki))).toBe(bytesToHex(keyIdOfModulus(new Uint8Array(256).fill(0xab))));
    expect(keyIdOfSpki(spki).length).toBe(32);
  });
});
