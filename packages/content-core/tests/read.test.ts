import { describe, expect, it } from "vitest";
import { encryptContentObject, readEncryptedContentObject } from "../src";

describe("content-core read", () => {
  it("decrypts a previously encrypted content object", async () => {
    const contentKeyBase64 = Buffer.alloc(32, 7).toString("base64");
    const plaintext = Buffer.from("preview-bytes");
    const encrypted = encryptContentObject(plaintext, contentKeyBase64);
    const object = await readEncryptedContentObject({
      objectKey: "object-1",
      contentKeyBase64,
      downloadObject: async () => encrypted,
    });
    expect(Buffer.from(object)).toEqual(plaintext);
  });
});
