/**
 * @bugfix test-launch-keychain-prompt
 * @regression-proof
 *
 * Every Playwright launch of the desktop app from the integration suite, the
 * e2e suite and the Node scripts must pass TEST_KEYCHAIN_ARGS
 * (`--use-mock-keychain`). Without it, safeStorage on macOS opens the
 * operator's login keychain. An ad-hoc-signed rebuild is not on that item's
 * access list, so the main process blocks on a password prompt: the login
 * click never returns and every login-dependent test times out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_KEYCHAIN_ARGS } from "../scripts/test-keychain-args.mjs";

const DESKTOP_DIR = join(import.meta.dirname, "..");
/** A statement that launches the app (not a string that merely mentions the call). */
const LAUNCH_STATEMENT = /^\s*(?:(?:const|let)\s+\w+\s*=\s*|\w+\s*=\s*)?await _?electron\.launch\(/m;
const LAUNCH_DIRS = ["tests", "e2e", "e2e-perf", "scripts"];
/** An `args: [...]` array that starts the app entrypoint without the shared switches. */
const BARE_ENTRYPOINT_ARGS = /args:\s*\[(?![^\]]*TEST_KEYCHAIN_ARGS)[^\]]*\bentrypoint\b[^\]]*\]/g;

const launchingFiles = (): string[] =>
  LAUNCH_DIRS.flatMap((dir) => {
    const abs = join(DESKTOP_DIR, dir);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return [];
    }
    return names
      .filter((name) => /\.(ts|mjs)$/.test(name))
      .map((name) => join(dir, name))
      .filter((rel) => LAUNCH_STATEMENT.test(readFileSync(join(DESKTOP_DIR, rel), "utf8")));
  });

describe("test launches use the mock keychain", () => {
  it("TEST_KEYCHAIN_ARGS is the mock-keychain switch", () => {
    expect(TEST_KEYCHAIN_ARGS).toEqual(["--use-mock-keychain"]);
  });

  it("every electron.launch in tests, e2e and scripts passes TEST_KEYCHAIN_ARGS", () => {
    const files = launchingFiles();
    console.info(`[test-keychain-args] files launching Electron: ${files.length}`);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((rel) => {
      const source = readFileSync(join(DESKTOP_DIR, rel), "utf8");
      const bare = [...source.matchAll(BARE_ENTRYPOINT_ARGS)].map((m) => `${rel}: ${m[0]}`);
      return source.includes("...TEST_KEYCHAIN_ARGS")
        ? bare
        : [...bare, `${rel}: launches Electron without ...TEST_KEYCHAIN_ARGS`];
    });
    if (violations.length > 0) console.error(`[test-keychain-args] violations:\n${violations.join("\n")}`);
    expect(violations).toEqual([]);
  });
});

// @req REL-UPD-02 @bugfix @regression-proof
// Launching the bare script (`electron out/main/index.js`) leaves Electron with
// no package.json, so app.getVersion() is "0.0". On staging until 2026-11-02
// that made electron-updater throw before createWindow(): no e2e window opened.
// Launchers start the app dir instead (package.json "main" -> out/main/index.js).
const SCRIPT_ENTRYPOINT = /\b(?:entrypoint|ENTRYPOINT)\s*=\s*join\([^)]*["']index\.js["']\s*\)/g;
const ENTRYPOINT_DIRS = [...LAUNCH_DIRS, "e2e-ultimate/lib"];

describe("test launches start the app dir", () => {
  it("no launcher in tests, e2e, scripts or e2e-ultimate points its entrypoint at out/main/index.js", () => {
    const files = ENTRYPOINT_DIRS.flatMap((dir) => {
      try {
        return readdirSync(join(DESKTOP_DIR, dir))
          .filter((name) => /\.(ts|mjs)$/.test(name))
          .map((name) => join(dir, name));
      } catch {
        return [];
      }
    });
    console.info(`[test-launch-app-dir] files scanned: ${files.length}`);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((rel) =>
      [...readFileSync(join(DESKTOP_DIR, rel), "utf8").matchAll(SCRIPT_ENTRYPOINT)].map((m) => `${rel}: ${m[0]}`),
    );
    if (violations.length > 0) console.error(`[test-launch-app-dir] violations:\n${violations.join("\n")}`);
    expect(violations).toEqual([]);
  });
});
