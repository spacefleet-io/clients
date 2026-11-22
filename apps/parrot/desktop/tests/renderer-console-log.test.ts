/**
 * @level unit
 * REL-LOG-06: the window's warnings and errors went into `parrot-main.log` as printed, so a failed fetch's URL or a
 * player error naming a song's file sat in the file a user may send us. They now go through the same scrubber as
 * the error log before they are written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rendererConsoleLine } from "../src/main/rendererConsole";

const SUITE = "parrot-renderer-console-log";
const mainSource = readFileSync(join(__dirname, "../src/main/index.ts"), "utf8");

describe(`[${SUITE}]`, () => {
  it("@req REL-LOG-06[parrot] writes a renderer warning or error without its URL, path, file name or title", () => {
    const message =
      'Failed to load "Paranoid Android" from /home/chris/Music/Radiohead/OK Computer/02 Paranoid Android.flac via https://silo1-a.spacefleet.io/storage/objects/abc123def456';
    const line = rendererConsoleLine("error", message);
    console.info(`[${SUITE}] line=${line}`);
    expect(line).toMatch(/^\[renderer:error\] /);
    for (const leak of ["Paranoid", "Radiohead", "OK Computer", "/home/chris", ".flac", "silo1-a", "abc123def456"]) {
      expect(line).not.toContain(leak);
    }
  });

  it("@req REL-LOG-06[parrot] keeps only warnings and errors", () => {
    expect(rendererConsoleLine("warning", "slow frame")).toBe("[renderer:warning] slow frame");
    expect(rendererConsoleLine("info", "hello")).toBeNull();
    expect(rendererConsoleLine("debug", "hello")).toBeNull();
  });

  it("@req REL-LOG-06[parrot] the main process writes renderer lines only through the scrubbing helper", () => {
    const handler = mainSource.slice(mainSource.indexOf('"console-message"'), mainSource.indexOf('"console-message"') + 400);
    console.info(`[${SUITE}] handler=${JSON.stringify(handler.slice(0, 200))}`);
    expect(handler).toContain("rendererConsoleLine(details.level, details.message)");
    expect(handler).not.toMatch(/log\(`\[renderer:\$\{details\.level\}\] \$\{details\.message\}`\)/);
  });
});
