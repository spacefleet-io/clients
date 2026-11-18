/**
 * REL-INST-03 (as Badger): a Parrot release Windows build without the signing secrets is refused; only
 * the dev-key test package (`package.mjs --test-build`) builds unsigned, with a `-devkey` version.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig } from "../electron-builder.config.mjs";

const appDir = join(import.meta.dirname, "..");
const pkg: unknown = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const version = pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "";

type Config = { extraMetadata: { version?: string }; win: { verifyUpdateCodeSignature?: boolean; azureSignOptions?: unknown } };
const config = (env: Record<string, string | undefined>, testBuild?: boolean): Config =>
  createBuilderConfig({ targetId: "windows-x64", env, testBuild }) as unknown as Config;

describe("Parrot Windows test build @req REL-INST-03", () => {
  it("refuses a release Windows build without the signing secrets", () => {
    expect(() => config({})).toThrow(/Windows signing not configured, but the updater requires updates signed by/);
  });

  it("builds the dev-key test package unsigned, marked -devkey, with no publisher check", () => {
    const test = config({}, true);
    console.info(`[parrot-windows-test-build] ${JSON.stringify({ extraMetadata: test.extraMetadata, win: test.win })}`);
    expect(test.extraMetadata.version).toBe(`${version}-devkey`);
    expect(test.win.verifyUpdateCodeSignature).toBe(false);
    expect(test.win.azureSignOptions).toBeUndefined();
  });

  it("keeps the release version on a non-test build of another target", () => {
    expect(createBuilderConfig({ targetId: "linux-x64", env: {} }).extraMetadata).toEqual({ homepage: "https://spaceparrot.io" });
  });
});
