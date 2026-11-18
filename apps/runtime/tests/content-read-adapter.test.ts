import { describe, expect, it } from "vitest";
import { encryptContentObject } from "@space/content-core";
import { readRuntimeContentObject } from "../src/core/content/readAdapter";

describe("runtime content read adapter [content-read-adapter]", () => {
  it("@bugfix @regression-proof decrypts stored content objects through the shared content-core read path", async () => {
    const contentKeyBase64 = Buffer.alloc(32, 11).toString("base64");
    const encrypted = encryptContentObject(Buffer.from("hello from content object"), contentKeyBase64);
    const bytes = await readRuntimeContentObject({
      objectKey: "object-1",
      contentKeyBase64,
      downloadObject: async () => encrypted,
    });
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello from content object");
  });
});
