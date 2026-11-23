import { describe, expect, it } from "vitest";
import {
  PAIRING_V1_REQUESTS_ACCEPTED,
  commitmentFingerprint,
  commitmentOpens,
  fingerprintFromLink,
  fingerprintMatches,
  formatCheckCode,
  generateDeviceKeyPair,
  isPairingBlob32,
  newPairingNonce,
  pairingCheckCode,
  pairingCommitment,
  withCommitmentFingerprint,
} from "../src";
import vectors from "./vectors-v2.json";

const log = (step: string, extra: Record<string, unknown> = {}) => console.info(`[check-code.test] ${step}`, extra);

/** @req PRIV-PAIR-01 */
describe("pairing check v2 (commitment + check code)", () => {
  it("reproduces the published vector byte for byte", () => {
    const commitment = pairingCommitment(vectors.publicKey, vectors.requesterNonce);
    log("vector", { commitment, expected: vectors.commitment });
    expect(commitment).toBe(vectors.commitment);
    expect(commitmentFingerprint(commitment)).toBe(vectors.fingerprint);
    const code = pairingCheckCode({
      publicKey: vectors.publicKey,
      commitment,
      approverNonce: vectors.approverNonce,
      requesterNonce: vectors.requesterNonce,
    });
    expect(code).toBe(vectors.checkCode);
    expect(formatCheckCode(code)).toBe("067 383");
  });

  it("opens only with the committed nonce and key", () => {
    const device = generateDeviceKeyPair();
    const nR = newPairingNonce();
    const C = pairingCommitment(device.publicKey, nR);
    expect(commitmentOpens(C, device.publicKey, nR)).toBe(true);
    expect(commitmentOpens(C, device.publicKey, newPairingNonce())).toBe(false);
    expect(commitmentOpens(C, generateDeviceKeyPair().publicKey, nR)).toBe(false);
    expect(commitmentOpens("not base64!", device.publicKey, nR)).toBe(false);
  });

  it("a server swapping in its own key and numbers shows a different code on each screen", () => {
    // Honest receiver R, honest sender A, a server M that relays its own values to each side.
    let matches = 0;
    const runs = 200;
    for (let i = 0; i < runs; i += 1) {
      const r = generateDeviceKeyPair();
      const nR = newPairingNonce();
      const cR = pairingCommitment(r.publicKey, nR);
      // M must commit towards A before A's nonce exists.
      const m = generateDeviceKeyPair();
      const nM = newPairingNonce();
      const cM = pairingCommitment(m.publicKey, nM);
      const nA = newPairingNonce();
      // M picks what R sees as the sender's nonce; best it can do is anything, R's nR stays hidden until then.
      const nAForR = newPairingNonce();
      const onReceiver = pairingCheckCode({ publicKey: r.publicKey, commitment: cR, approverNonce: nAForR, requesterNonce: nR });
      const onSender = pairingCheckCode({ publicKey: m.publicKey, commitment: cM, approverNonce: nA, requesterNonce: nM });
      if (onReceiver === onSender) matches += 1;
    }
    log("mitm runs", { runs, matches });
    // 1 in 1 000 000 per run: 200 runs matching even once would be a broken code.
    expect(matches).toBe(0);
  });

  it("the receiver writes the QR fingerprint itself, over whatever the server put in the link", () => {
    const C = pairingCommitment(vectors.publicKey, vectors.requesterNonce);
    const fromServer = "https://spacefleet.io/pair/badger?code=ABCDEFGH#c=AAAAAAAAAAAAAAAAAAAAAA";
    const link = withCommitmentFingerprint(fromServer, C);
    log("link", { link });
    expect(link).toBe(`https://spacefleet.io/pair/badger?code=ABCDEFGH#c=${vectors.fingerprint}`);
    expect(fingerprintFromLink(link)).toBe(vectors.fingerprint);
    expect(fingerprintMatches(fingerprintFromLink(link), C)).toBe(true);
    expect(fingerprintMatches(fingerprintFromLink(fromServer), C)).toBe(false);
    expect(fingerprintFromLink("https://spacefleet.io/pair/badger?code=ABCDEFGH")).toBeNull();
    expect(fingerprintMatches(null, C)).toBe(false);
  });

  it("checks the shape of 32-byte values", () => {
    expect(isPairingBlob32(vectors.commitment)).toBe(true);
    expect(isPairingBlob32(vectors.fingerprint)).toBe(false);
    expect(isPairingBlob32(42)).toBe(false);
  });
});

/** @req PRIV-PAIR-04 */
describe("v1 requests", () => {
  it("sending apps refuse them (the one switch is off)", () => {
    expect(PAIRING_V1_REQUESTS_ACCEPTED).toBe(false);
  });
});
