/**
 * @test-id PARROT-NAME-001
 * @level unit
 * @req PLAT-SUITE-02[parrot]
 * @req PAR-LOOK-02[parrot]
 * @why Chris 2026-11-08 (chat, Parrot design approval): the product is "Parrot", never "SpaceParrot". The phone's
 *   library-key screen read "SPACEPARROT" under the mascot. Lower-case `spaceparrot` stays legal: it is the domain and
 *   internal ids (Linux executable, user-data folder), never shown as the app's name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parrotShellTheme } from "../src/theme";

const parrotRoot = resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "build", "dist", "out", ".gradle", "tests", "e2e", ".cxx"]);
const TEXT_FILE = /\.(tsx?|mjs|cjs|js|json|html|xml|plist|strings|css)$/;
const OLD_NAME = /SpaceParrot|Space Parrot/;
const COMMENT = /^\s*(\/\/|\*|\/\*|<!--)/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    return TEXT_FILE.test(name) ? [path] : [];
  });

describe("Parrot's name", () => {
  it("the phone brand reads Parrot", () => {
    expect(parrotShellTheme.brandName).toBe("Parrot");
  });

  it("no Parrot app (desktop, phone, web player) shows SpaceParrot outside comments", () => {
    const files = sourceFiles(parrotRoot);
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (OLD_NAME.test(line) && !COMMENT.test(line) ? [`${relative(parrotRoot, file)}:${i + 1}: ${line.trim()}`] : []))
    );
    console.info(`[product-name] scanned ${files.length} files under apps/parrot`);
    if (hits.length) console.error("[product-name] SpaceParrot in user-facing text:\n" + hits.join("\n"));
    expect(files.length).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });
});
