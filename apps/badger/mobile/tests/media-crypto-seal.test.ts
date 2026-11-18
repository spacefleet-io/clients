// @req PLAY-SUBGET-03[badger-mobile]
// A fetched subtitle is sealed on the phone (SFV1) before it reaches the vault: the phone opens its own seal, and so
// does the computer app's Node opener (`@space/media-crypto`), so every Badger app reads the subtitle back.
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptMediaObject as nodeOpen } from "@space/media-crypto";
import { decryptMediaObject, encryptMediaObject, setMediaKeyFromBase64 } from "../src/lib/mediaCrypto";

vi.mock("react-native-quick-crypto", async () => ({ default: await import("node:crypto") }));
vi.mock("../src/lib/storage", () => ({ base64ToBytes: (value: string) => new Uint8Array(Buffer.from(value, "base64")) }));

describe("encryptMediaObject (phone SFV1 seal)", () => {
  it("@req PLAY-SUBGET-03 seals a subtitle the phone and the computer app both open", () => {
    const libraryKey = randomBytes(32).toString("base64");
    setMediaKeyFromBase64(libraryKey);
    const text = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBonjour Sintel\n");
    console.log("[PLAY-SUBGET-03] phase=seal", JSON.stringify({ bytes: text.length }));
    const sealed = encryptMediaObject(text);
    console.log("[PLAY-SUBGET-03] sealed", JSON.stringify({ bytes: sealed.length, magic: Buffer.from(sealed.subarray(0, 4)).toString() }));
    expect(Buffer.from(sealed.subarray(0, 4)).toString()).toBe("SFV1");
    expect(Buffer.from(sealed).includes(Buffer.from("Bonjour"))).toBe(false);

    const opened = decryptMediaObject(sealed);
    console.log("[PLAY-SUBGET-03] phone open", JSON.stringify({ wasEncrypted: opened.wasEncrypted, bytes: opened.plaintext.length }));
    expect(opened.wasEncrypted).toBe(true);
    expect(new TextDecoder().decode(opened.plaintext)).toContain("Bonjour Sintel");

    const openedOnComputer = nodeOpen(sealed, libraryKey);
    console.log("[PLAY-SUBGET-03] computer open", JSON.stringify({ bytes: openedOnComputer.length }));
    expect(openedOnComputer.toString("utf8")).toContain("Bonjour Sintel");
  });

  it("@req PLAY-SUBGET-03 refuses to seal without the library's media key", () => {
    setMediaKeyFromBase64(null);
    expect(() => encryptMediaObject(new Uint8Array([1, 2, 3]))).toThrow("media_key_missing");
  });
});
