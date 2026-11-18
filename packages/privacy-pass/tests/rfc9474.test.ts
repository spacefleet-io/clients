import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToBigInt, modinv, modpow } from "../src/bigint";
import { bytesToHex, hexToBytes } from "../src/bytes";
import { blind, emsaPssEncode, finalize, verify } from "../src/rsabssa";

// RFC 9474 appendix A.3, RSABSSA-SHA384-PSS-Deterministic (RSA-4096 key, so the code is modulus-size generic).
const vector = JSON.parse(readFileSync(new URL("../vectors/rfc9474-a3.json", import.meta.url), "utf8")) as Record<string, string>;
const pk = { n: bytesToBigInt(hexToBytes(vector.n!)), e: bytesToBigInt(hexToBytes(vector.e!)) };
const d = bytesToBigInt(hexToBytes(vector.d!));

describe("RFC 9474 appendix A.3 test vector (RSABSSA-SHA384-PSS-Deterministic)", () => {
  it("modpow / modinv agree with the key: e*d = 1 mod lcm and inv * blinding factor = 1", () => {
    console.log("[rfc9474] phase: bigint sanity");
    const m = 0x1234567890abcdefn;
    expect(modpow(modpow(m, pk.e, pk.n), d, pk.n)).toBe(m);
    const inv = bytesToBigInt(hexToBytes(vector.inv!));
    const r = modinv(inv, pk.n)!;
    expect((r * inv) % pk.n).toBe(1n);
    expect(modinv(2n * 3n, 6n)).toBeNull();
  });

  it("EMSA-PSS encoding reproduces encoded_msg for the published salt", () => {
    console.log("[rfc9474] phase: emsa-pss-encode");
    const emBits = pk.n.toString(2).length - 1;
    const em = emsaPssEncode(hexToBytes(vector.prepared_msg!), emBits, hexToBytes(vector.salt!));
    expect(bytesToHex(em)).toBe(vector.encoded_msg);
  });

  it("blind with the published salt and inverse reproduces blinded_msg", () => {
    console.log("[rfc9474] phase: blind");
    const result = blind(pk, hexToBytes(vector.msg!), { salt: hexToBytes(vector.salt!), inv: hexToBytes(vector.inv!) });
    expect(bytesToHex(result.blindedMsg)).toBe(vector.blinded_msg);
    expect(bytesToHex(result.inv)).toBe(vector.inv);
  });

  it("the raw private operation on blinded_msg gives blind_sig", () => {
    console.log("[rfc9474] phase: blind sign (BigInt reference)");
    const sig = modpow(bytesToBigInt(hexToBytes(vector.blinded_msg!)), d, pk.n);
    expect(sig.toString(16).padStart(vector.blind_sig!.length, "0")).toBe(vector.blind_sig);
  });

  it("finalize unblinds blind_sig into sig and verifies it", () => {
    console.log("[rfc9474] phase: finalize + verify");
    const sig = finalize(pk, hexToBytes(vector.msg!), hexToBytes(vector.blind_sig!), hexToBytes(vector.inv!));
    expect(bytesToHex(sig)).toBe(vector.sig);
    expect(verify(pk, hexToBytes(vector.msg!), hexToBytes(vector.sig!))).toBe(true);
  });

  it("rejects a wrong message, a flipped signature bit and a bad length", () => {
    console.log("[rfc9474] phase: negatives");
    const msg = hexToBytes(vector.msg!);
    const sig = hexToBytes(vector.sig!);
    const otherMsg = msg.slice();
    otherMsg[0] = otherMsg[0]! ^ 1;
    expect(verify(pk, otherMsg, sig)).toBe(false);
    const flipped = sig.slice();
    flipped[100] = flipped[100]! ^ 0x10;
    expect(verify(pk, msg, flipped)).toBe(false);
    expect(verify(pk, msg, sig.subarray(1))).toBe(false);
    expect(() => finalize(pk, msg, hexToBytes(vector.blind_sig!), hexToBytes(vector.blind_sig!))).toThrow();
  });

  it("random blinding round trips against the reference private operation", () => {
    console.log("[rfc9474] phase: random blinding");
    const msg = hexToBytes(vector.msg!);
    const result = blind(pk, msg);
    const blindSig = modpow(bytesToBigInt(result.blindedMsg), d, pk.n).toString(16).padStart(1024, "0");
    const sig = finalize(pk, msg, hexToBytes(blindSig), result.inv);
    expect(verify(pk, msg, sig)).toBe(true);
  });
});
