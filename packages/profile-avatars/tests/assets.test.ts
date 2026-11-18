/**
 * @test-id PROFILE-AVATARS-ASSETS-001
 * @level unit
 *
 * ACCT-PROF-05: the shipped pictures of the 22-avatar pack. Every id of `PROFILE_AVATAR_IDS` has a WebP in each size,
 * nothing else is shipped, and both generated entries (web URLs, native image sources) list every avatar.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_AVATAR_IDS } from "@space/shared/profileAvatars";

const PACKAGE = join(import.meta.dirname, "..");

/** Width and height of a lossy (`VP8 `) WebP. */
const webpSize = (bytes: Buffer) => {
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("VP8 ");
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
};

describe("profile avatar assets", () => {
  it.each([64, 256])("@req ACCT-PROF-05 ships exactly the pack's 22 avatars at %i px", (size) => {
    const folder = join(PACKAGE, "assets", String(size));
    const files = readdirSync(folder).sort();
    console.info(`[profile-avatars] assets/${size}: ${files.length} files`);
    expect(files).toEqual(PROFILE_AVATAR_IDS.map((id) => `${id}.webp`).sort());
    for (const file of files) expect(webpSize(readFileSync(join(folder, file))), file).toEqual({ width: size, height: size });
  });

  it("@req ACCT-PROF-05 the web and native entries name every avatar", () => {
    const web = readFileSync(join(PACKAGE, "src/web.ts"), "utf8");
    const native = readFileSync(join(PACKAGE, "src/native.ts"), "utf8");
    for (const id of PROFILE_AVATAR_IDS) {
      expect(web).toContain(`  ${id}: { small: ${id}64, large: ${id}256 },`);
      expect(native).toContain(`  ${id}: require("../assets/256/${id}.webp") as number,`);
    }
  });
});
