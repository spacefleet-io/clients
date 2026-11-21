/**
 * REL-UPD-07: install-type detection, the manual commands, the reading of pkexec + helper exit codes and the relaunch
 * after an update (packages/desktop-shell/src/updater/systemPackage.ts). The OS is faked through `SystemProbe`, except
 * for the relaunch, which runs for real in a child process.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { SYSTEM_UPDATE_EXIT as PACKAGING_EXIT } from "../../desktop-platform-linux/packaging/system-update.mjs";
import {
  SYSTEM_UPDATE_EXIT,
  canAskPassword,
  detectLinuxInstall,
  manualCommand,
  runSystemUpdate,
  systemUpdateHelperPath,
  type SystemProbe,
} from "../src/updater/systemPackage";

const log = (line: string, data?: unknown) => console.info(`[system-package] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const HELPER = "/usr/lib/spacebadger/system-update";

const probe = (o: Partial<Omit<SystemProbe, "run">> & { answers?: Record<string, { code: number | null; stdout?: string; stderr?: string }> } = {}) => {
  const run = vi.fn(async (command: string, _args: readonly string[]) => {
    const answer = o.answers?.[command] ?? { code: 1 };
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  });
  const p: SystemProbe = {
    env: o.env ?? {},
    exists: o.exists ?? (() => false),
    onPath: o.onPath ?? (() => false),
    run,
    relaunchAfterExit: vi.fn(),
  };
  return { p, run };
};

// @req REL-UPD-07[badger-desktop,parrot] the install type comes from what the system shows, never the distro's name
describe("detectLinuxInstall (REL-UPD-07)", () => {
  it("AppImage and Flatpak come from their runtimes' markers", async () => {
    expect(await detectLinuxInstall("spacebadger", probe({ env: { APPIMAGE: "/x/Badger.AppImage" } }).p)).toEqual({ kind: "appimage" });
    expect(await detectLinuxInstall("spacebadger", probe({ env: { FLATPAK_ID: "io.spacefleet.Badger" } }).p)).toEqual({
      kind: "flatpak",
      flatpakId: "io.spacefleet.Badger",
    });
    expect(await detectLinuxInstall("spacebadger", probe({ exists: (path) => path === "/.flatpak-info" }).p)).toEqual({ kind: "flatpak", flatpakId: null });
  });

  it.each([
    ["pacman", { pacman: { code: 0, stdout: "spacebadger\n" } }, ["pacman"], "pacman"],
    ["dpkg", { "dpkg-query": { code: 0, stdout: `spacebadger: ${HELPER}\n` } }, ["dpkg-query"], "apt"],
    ["rpm + dnf", { rpm: { code: 0, stdout: "spacebadger" } }, ["rpm", "dnf"], "dnf"],
    ["rpm + zypper", { rpm: { code: 0, stdout: "spacebadger" } }, ["rpm", "zypper"], "zypper"],
  ] as const)("%s owns the helper → manager %s", async (_label, answers, installed, manager) => {
    const { p, run } = probe({ exists: (path) => path === HELPER, onPath: (name) => (installed as readonly string[]).includes(name), answers });
    const install = await detectLinuxInstall("spacebadger", p);
    log("detected", { install, calls: run.mock.calls });
    expect(install).toEqual({ kind: "system", manager, helperPath: HELPER });
    // Every query is a fixed argument list with the helper's path, never a shell line.
    for (const [, args] of run.mock.calls) expect(args).toContain(HELPER);
  });

  it("a helper another package owns, or no helper at all, is not a SpaceFleet package", async () => {
    const other = probe({ exists: (path) => path === HELPER, onPath: (name) => name === "pacman", answers: { pacman: { code: 0, stdout: "evil\n" } } }).p;
    expect((await detectLinuxInstall("spacebadger", other)).kind).toBe("other");
    expect((await detectLinuxInstall("spacebadger", probe().p)).kind).toBe("other");
  });

  it("the helper path is the packaging's", () => {
    expect(systemUpdateHelperPath("spaceparrot")).toBe("/usr/lib/spaceparrot/system-update");
  });
});

// @req REL-UPD-07[badger-desktop,parrot] the app reads the helper's exit codes as packaging defines them
describe("runSystemUpdate (REL-UPD-07)", () => {
  it("mirrors the packaging's exit codes", () => {
    expect(SYSTEM_UPDATE_EXIT).toEqual(PACKAGING_EXIT);
  });

  it("runs pkexec with the helper as its only argument and reads before/after", async () => {
    const { p, run } = probe({ answers: { pkexec: { code: 0, stdout: "SF_SYSTEM_UPDATE=0 before=0.1.5-1 after=0.1.9-1\n" } } });
    expect(await runSystemUpdate(HELPER, p)).toEqual({ result: "updated", before: "0.1.5-1", after: "0.1.9-1" });
    expect(run.mock.calls).toEqual([["pkexec", [HELPER]]]);
  });

  it.each([
    [126, { result: "dismissed" }],
    [10, { result: "failed", failure: "notNewer" }],
    [11, { result: "failed", failure: "repoMissing" }],
    [12, { result: "failed", failure: "needsSystemUpdate" }],
    [13, { result: "failed", failure: "packageManager" }],
    [127, { result: "failed", failure: "notAuthorized" }],
    [69, { result: "failed", failure: "other" }],
    [null, { result: "failed", failure: "noPasswordDialog" }],
  ] as const)("exit %s → %j", async (code, expected) => {
    const outcome = await runSystemUpdate(HELPER, probe({ answers: { pkexec: { code, stderr: "line 1\nline 2\n" } } }).p);
    log("outcome", { code, outcome });
    expect(outcome).toMatchObject(expected);
  });

  // Real package-manager output when SpaceFleet's repository can't be reached (DNS, refused, timeout); the cause may sit
  // above the six lines kept as the detail.
  it.each([
    ["pacman refused", "error: failed retrieving file 'spacefleet.db' from 127.0.0.1:8080 : Failed to connect to 127.0.0.1 port 8080 after 0 ms: Couldn't connect to server"],
    ["pacman DNS", "error: failed retrieving file 'spacefleet.db' from packages.spacefleet.io : Could not resolve host: packages.spacefleet.io"],
    ["apt refused", "Err:1 http://127.0.0.1:8080/apt stable/main amd64 spaceparrot amd64 0.1.91\n  Could not connect to 127.0.0.1:8080 (127.0.0.1). - connect (111: Connection refused)"],
    ["apt DNS", "Err:1 https://packages.spacefleet.io/apt stable InRelease\n  Temporary failure resolving 'packages.spacefleet.io'"],
    ["dnf refused", ">>> Curl error (7): Could not connect to server for http://127.0.0.1:8080/rpm/repodata/repomd.xml"],
    ["dnf timeout", ">>> Curl error (28): Timeout was reached for https://packages.spacefleet.io/rpm/repodata/repomd.xml"],
    ["zypper DNS", "Download (curl) error for 'https://packages.spacefleet.io/rpm/repodata/repomd.xml':\nError code: Connection failed\nError message: Could not resolve host: packages.spacefleet.io"],
  ])("exit 13, %s → network", async (_name, output) => {
    const stderr = `${output}\nline\nline\nline\nline\nline\nline\n[system-update] could not update spaceparrot\n`;
    const outcome = await runSystemUpdate(HELPER, probe({ answers: { pkexec: { code: 13, stderr } } }).p);
    expect(outcome).toMatchObject({ result: "failed", failure: "network" });
  });

  it.each([
    ["apt 404", "E: Failed to fetch https://packages.spacefleet.io/apt/pool/main/Parrot-0.1.91-amd64.deb  404  Not Found"],
    ["pacman signature", 'error: spaceparrot: signature from "SpaceFleet" is invalid'],
  ])("exit 13, %s → packageManager", async (_name, stderr) => {
    const outcome = await runSystemUpdate(HELPER, probe({ answers: { pkexec: { code: 13, stderr } } }).p);
    expect(outcome).toMatchObject({ result: "failed", failure: "packageManager" });
  });
});

// @req REL-UPD-07[badger-desktop,parrot] without pkexec or a display the app shows the command to run by hand
describe("canAskPassword and manualCommand (REL-UPD-07)", () => {
  it("needs pkexec and a graphical session", () => {
    expect(canAskPassword(probe({ env: { DISPLAY: ":0" }, onPath: (name) => name === "pkexec" }).p)).toBe(true);
    expect(canAskPassword(probe({ env: { WAYLAND_DISPLAY: "wayland-0" }, onPath: (name) => name === "pkexec" }).p)).toBe(true);
    expect(canAskPassword(probe({ env: {}, onPath: (name) => name === "pkexec" }).p)).toBe(false);
    expect(canAskPassword(probe({ env: { DISPLAY: ":0" } }).p)).toBe(false);
  });

  it("gives the helper, the whole-system update when that is what is missing, or flatpak update", () => {
    const pacman = { kind: "system", manager: "pacman", helperPath: HELPER } as const;
    expect(manualCommand(pacman)).toBe(`sudo ${HELPER}`);
    expect(manualCommand(pacman, "notNewer")).toBe(`sudo ${HELPER}`);
    expect(manualCommand(pacman, "needsSystemUpdate")).toBe("sudo pacman -Syu");
    expect(manualCommand({ ...pacman, manager: "apt" }, "needsSystemUpdate")).toBe("sudo apt-get update && sudo apt-get upgrade");
    expect(manualCommand({ ...pacman, manager: "dnf" }, "needsSystemUpdate")).toBe("sudo dnf upgrade --refresh");
    expect(manualCommand({ ...pacman, manager: "zypper" }, "needsSystemUpdate")).toBe("sudo zypper update");
    expect(manualCommand({ kind: "flatpak", flatpakId: "io.spacefleet.Parrot" })).toBe("flatpak update io.spacefleet.Parrot");
    expect(manualCommand({ kind: "flatpak", flatpakId: null })).toBe("flatpak update");
  });
});

describe("relaunch after a system update (REL-UPD-07)", () => {
  // @req REL-UPD-07[badger-desktop,parrot] the new binary starts only after the updated app has exited
  it.skipIf(process.platform !== "linux")("nodeSystemProbe.relaunchAfterExit starts the command once the calling process has exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-relaunch-"));
    const marker = join(dir, "started");
    const driver = join(dir, "driver.mts");
    const moduleUrl = pathToFileURL(resolve(__dirname, "../src/updater/systemPackage.ts")).href;
    // The "app" arms the relaunch, says so, and exits when the test closes its stdin. The "new binary" is a shell that
    // writes into `marker` whether the app's pid was still alive when it started, so no timing is guessed.
    writeFileSync(
      driver,
      [
        `import { nodeSystemProbe } from ${JSON.stringify(moduleUrl)};`,
        `nodeSystemProbe.relaunchAfterExit("/bin/sh", ["-c", 'if kill -0 "$1" 2>/dev/null; then echo alive; else echo gone; fi > "$2.tmp" && mv "$2.tmp" "$2"', "sh", String(process.pid), ${JSON.stringify(marker)}]);`,
        `process.stdout.write("armed\\n");`,
        `process.stdin.resume();`,
        `process.stdin.on("end", () => process.exit(0));`,
      ].join("\n"),
    );
    try {
      const started = Promise.withResolvers<void>();
      const watcher = watch(dir, (_event, name) => name === "started" && started.resolve());
      const app = spawn("node", [driver], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      app.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const armed = Promise.withResolvers<void>();
      app.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("armed") && armed.resolve());
      const exited = Promise.withResolvers<number | null>();
      app.on("exit", (code) => {
        exited.resolve(code);
        armed.reject(new Error(`driver exited (${code}) before arming: ${stderr}`));
      });
      await armed.promise;
      app.stdin.end();
      const exitCode = await exited.promise;
      await started.promise;
      watcher.close();
      const seen = readFileSync(marker, "utf8").trim();
      log("relaunch", { exitCode, seen, stderr });
      expect(exitCode).toBe(0);
      expect(seen).toBe("gone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
