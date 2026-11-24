// @req REL-FAM-03
/**
 * @test-id E2E-ANDROID-CLI-DEVICE-001
 * @level integration
 * @why The phones are shared through sf-phone leases. Badger's phone harness ran its preflight on the only attached
 *      phone when asked for `--help` (2026-11-24). Parrot's `e2e-android/cli.ts` had the same two gaps: `--help` fell
 *      through to `run`, and with no phone named it used the attached one. Both harnesses now print the usage for
 *      `--help`/`-h` and stop before any adb call when no phone is named. The CLI runs as a subprocess with a fake
 *      `adb` first on PATH that logs every call and reports one attached phone, so the old auto-pick would have driven it.
 * @covers apps/parrot/mobile/e2e-android/cli.ts: main; packages/android-e2e/src/adb.ts: namedSerial
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The host's environment. The global `process` type here is the app's (src/declarations.d.ts: the three build-time
// variables React Native inlines), so it is read as the open map Node gives the test, as apple-tv-native-modules does.
const hostEnv: Record<string, string | undefined> = process.env;

const MOBILE = join(import.meta.dirname, "..");
const fakeDir = mkdtempSync(join(tmpdir(), "e2e-android-cli-"));
const adbLog = join(fakeDir, "adb.log");
writeFileSync(join(fakeDir, "adb"), `#!/bin/sh\necho "$*" >> "${adbLog}"\nprintf 'List of devices attached\\nFAKE0001\\tdevice\\n'\n`);
chmodSync(join(fakeDir, "adb"), 0o755);

function cli(...args: string[]) {
  rmSync(adbLog, { force: true });
  const env: Record<string, string | undefined> = { ...hostEnv, PATH: `${fakeDir}:${hostEnv.PATH}` };
  delete env.ANDROID_SERIAL;
  delete env.ADB_SERVER_SOCKET;
  const r = spawnSync("bun", ["e2e-android/cli.ts", ...args], { cwd: MOBILE, env, encoding: "utf8", timeout: 60_000 });
  const adbCalls = existsSync(adbLog) ? readFileSync(adbLog, "utf8").trim().split("\n").filter(Boolean) : [];
  console.info(`[E2E-ANDROID-CLI-DEVICE-001] cli ${args.join(" ")} -> exit ${r.status}, adb calls ${adbCalls.length}`);
  return { status: r.status, out: `${r.stdout}${r.stderr}`, adbCalls };
}

afterAll(() => rmSync(fakeDir, { recursive: true, force: true }));

describe("e2e-android CLI device choice", () => {
  it("--help and -h print the usage and touch no device", () => {
    for (const args of [["--help"], ["-h"], ["run", "--help"]]) {
      const r = cli(...args);
      expect(r.status).toBe(0);
      expect(r.out).toContain("--serial S");
      expect(r.adbCalls).toEqual([]);
    }
  });

  it("refuses run and install when no phone is named, before any adb call", () => {
    for (const args of [["run", "--out", join(fakeDir, "out")], ["install", "/nonexistent.apk"]]) {
      const r = cli(...args);
      expect(r.status).toBe(2);
      expect(r.out).toMatch(/no device named: pass --serial/);
      expect(r.adbCalls).toEqual([]);
    }
  });

  it("still lists cases without a phone", () => {
    const r = cli("list");
    expect(r.status).toBe(0);
    expect(r.out).toContain("cold-launch");
    expect(r.adbCalls).toEqual([]);
  });
});
