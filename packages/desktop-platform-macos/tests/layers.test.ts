import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMacosBinaries, MPV_HELPER_EXECUTABLE } from "../src/binaries";
import { parseLsofHolders, parseProcessRow, parseThreadRows, parseVmStat, createMacosDiagnostics } from "../src/diagnostics";
import { createMacosHardware, parseDisplaysJson, pickGpuVendor } from "../src/hardware";
import { MAX_SOCKET_PATH_BYTES, macosMpvEndpoint } from "../src/ipc";
import { macosPaths } from "../src/paths";
import { createMacosProcessGroup } from "../src/processGroup";
import { descendantsOf, parsePsRows } from "../src/ps";
import { macosShell } from "../src/shell";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-macos-"));
  temps.push(dir);
  return dir;
};
const touch = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("binaries", () => {
  const binaries = createMacosBinaries("arm64");

  // @req REL-MAC-09 the helper is "Badger Player.app", in the deps bundle and in the packaged app
  it("prefers the packaged Contents/Helpers/Badger Player.app for mpv, with Resources/deps/lib as its library dir", () => {
    const contents = temp();
    const resources = join(contents, "Resources");
    expect(MPV_HELPER_EXECUTABLE).toBe(join("Badger Player.app", "Contents", "MacOS", "mpv"));
    touch(join(contents, "Helpers", MPV_HELPER_EXECUTABLE));
    touch(join(resources, "deps", MPV_HELPER_EXECUTABLE));
    touch(join(resources, "deps", "bin", "ffmpeg"));
    // cwd inside the temp dir: the repo's own vendor/deps must not leak into the candidate list.
    const mpv = binaries.resolveAll("mpv", { resourcesPath: resources, cwd: contents, env: {} });
    expect(mpv.map((binary) => binary.path)).toEqual([
      join(resources, "..", "Helpers", MPV_HELPER_EXECUTABLE),
      join(resources, "deps", MPV_HELPER_EXECUTABLE),
    ]);
    expect(mpv[0]!.libDirs).toEqual([join(resources, "deps", "lib")]);
    expect(mpv[0]!.source).toBe("packaged-deps");
    const ffmpeg = binaries.resolve("ffmpeg", { resourcesPath: resources, cwd: contents, env: {} });
    expect(ffmpeg?.path).toBe(join(resources, "deps", "bin", "ffmpeg"));
    expect(ffmpeg?.libDirs).toEqual([join(resources, "deps", "lib")]);
  });

  it("names the bundled location of each binary relative to the deps dir", () => {
    expect(binaries.bundledPath?.("mpv")).toBe("Badger Player.app/Contents/MacOS/mpv");
    expect(binaries.bundledPath?.("ffprobe")).toBe("bin/ffprobe");
    expect(binaries.executableName("ffmpeg")).toBe("ffmpeg");
  });

  it("puts library dirs on DYLD_FALLBACK_LIBRARY_PATH (keeping dyld's default list), never DYLD_LIBRARY_PATH", () => {
    const env = binaries.withLibraryPath({ PATH: "/bin" }, ["/deps/lib", "/deps/lib"]);
    expect(env).toEqual({ PATH: "/bin", DYLD_FALLBACK_LIBRARY_PATH: "/deps/lib:/usr/local/lib:/usr/lib" });
    expect(binaries.withLibraryPath({ DYLD_FALLBACK_LIBRARY_PATH: "/opt/lib:/deps/lib" }, ["/deps/lib"]).DYLD_FALLBACK_LIBRARY_PATH).toBe("/deps/lib:/opt/lib");
    expect(binaries.launchEnv({ libDirs: [] }, { A: "1" })).toEqual({ A: "1" });
  });
});

describe("paths and mpv IPC", () => {
  // @req PLAT-DESK-07[runtime]
  it("keeps runtime data and user data under ~/Library/Application Support, named after the product", () => {
    expect(macosPaths.runtimeDataDir({})).toBe(join(homedir(), "Library", "Application Support", "SpaceFleet", "runtime"));
    expect(macosPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "/data/rt" })).toBe("/data/rt");
    expect(macosPaths.appUserDataDir({ appData: "/AS", productName: "SpaceBadger", legacyDir: ["@space", "badger"] })).toBe("/AS/SpaceBadger");
  });

  it("restrictFileToOwner makes a file 0600 and restrictDirToOwner a dir 0700", () => {
    const dir = temp();
    const file = join(dir, "secret");
    writeFileSync(file, "x", { mode: 0o644 });
    macosPaths.restrictFileToOwner(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(dir, 0o755);
    macosPaths.restrictDirToOwner(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("uses a unix socket in TMPDIR, falling back to /tmp and then a hashed name under the 104-byte sun_path limit", () => {
    expect(macosMpvEndpoint("abc", "/var/folders/x/T")).toBe("/var/folders/x/T/sf-mpv-abc.sock");
    expect(macosMpvEndpoint("abc", `/${"d".repeat(120)}`)).toBe("/tmp/sf-mpv-abc.sock");
    const hashed = macosMpvEndpoint("t".repeat(150), `/${"d".repeat(120)}`);
    expect(hashed).toMatch(/^\/tmp\/sf-mpv-[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(hashed)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
  });
});

describe("hardware", () => {
  const appleSilicon = JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M1 Pro", spdisplays_vendor: "sppci_vendor_Apple", sppci_model: "Apple M1 Pro" }] });
  const intelWithAmd = JSON.stringify({
    SPDisplaysDataType: [
      { _name: "Intel UHD Graphics 630", spdisplays_vendor: "Intel", sppci_model: "Intel UHD Graphics 630" },
      { _name: "AMD Radeon Pro 5500M", spdisplays_vendor: "sppci_vendor_AMD", sppci_model: "AMD Radeon Pro 5500M" },
    ],
  });

  it("parses system_profiler GPU entries and prefers Apple, then a discrete AMD over the Intel iGPU", () => {
    expect(parseDisplaysJson(appleSilicon)).toEqual(["Apple Apple M1 Pro Apple M1 Pro"]);
    expect(pickGpuVendor(parseDisplaysJson(appleSilicon))).toBe("apple");
    expect(pickGpuVendor(parseDisplaysJson(intelWithAmd))).toBe("amd");
    expect(parseDisplaysJson("not json")).toEqual([]);
    expect(pickGpuVendor([])).toBe("");
  });

  it("reads the GPUs once and reports VideoToolbox with no device, memory cap or CPU limits", async () => {
    let reads = 0;
    const hardware = createMacosHardware({ readGpus: async () => (reads += 1, ["Intel UHD Graphics 630"]) });
    expect(await hardware.detectGpuVendor()).toBe("intel");
    expect(await hardware.detectGpuVendor()).toBe("intel");
    expect(reads).toBe(1);
    expect(hardware.encoderPolicy.order).toEqual(["videotoolbox"]);
    expect(hardware.deviceFor("videotoolbox")).toBeNull();
    expect(hardware.memoryLimitBytes()).toBeNull();
    expect(hardware.readCpuLimits()).toEqual({ affinityList: null, affinityCount: null, quota: null, checked: [] });
  });
});

describe("diagnostics", () => {
  it("parses ps, ps -M, vm_stat and lsof output", () => {
    expect(parseProcessRow("  42     1    42 Ss    1.5  2048  409600   01:02:03   0:04.50")).toEqual({
      pid: 42,
      parentPid: 1,
      pgid: 42,
      state: "Ss",
      cpuPercent: 1.5,
      rssBytes: 2048 * 1024,
      vszBytes: 409600 * 1024,
      elapsed: "01:02:03",
      cpuTime: "0:04.50",
    });
    expect(parseProcessRow("")).toBeNull();
    const threads = [
      "USER             PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
      "chris          56567 s000    2.1 S    31T   0:24.62   3:06.64 /usr/bin/ffmpeg",
      "               56567        97.0 R    31T   0:00.41   0:00.44 ",
    ].join("\n");
    expect(parseThreadRows(threads)).toEqual({ threads: 2, threadStates: { S: 1, R: 1 }, nonSleepingThreads: ["2:R pri=31T cpu=97.0%"] });
    const vm = ["Mach Virtual Memory Statistics: (page size of 16384 bytes)", "Pages free:     10.", "Pages wired down:   2.", "Pages occupied by compressor:  3."].join("\n");
    expect(parseVmStat(vm)).toEqual({ freeBytes: 163840, wiredBytes: 32768, compressedBytes: 49152 });
    expect(parseLsofHolders("p12\ncnode\nf20\np12\np99\ncmpv\n")).toEqual([{ pid: 12, comm: "node" }, { pid: 99, comm: "mpv" }]);
  });

  it("never runs a tool for an invalid pid or port", async () => {
    const calls: string[] = [];
    const diagnostics = createMacosDiagnostics({
      runPs: async (args) => (calls.push(`ps ${args.join(" ")}`), null),
      run: async (command) => (calls.push(command), null),
    });
    expect(await diagnostics.readProcess(-1)).toEqual({ platform: "macos", pid: -1, alive: false });
    expect(await diagnostics.readPortHolders(70000)).toEqual({ platform: "macos", port: 70000 });
    expect(calls).toEqual([]);
  });
});

describe("ps and process groups", () => {
  const table = parsePsRows("  10  1 10 S\n 11 10 10 S\n 12 11 10 Z\n 13 11 10 R+\n 20 1 20 S\nnoise\n");

  it("walks live descendants parents-first, skipping zombies", () => {
    expect(descendantsOf(table, 10)).toEqual([10, 11, 13]);
    expect(descendantsOf(table, 99)).toEqual([99]);
  });

  it.skipIf(process.platform !== "darwin")("treats a group whose members are all zombies as dead, and an empty group as dead", async () => {
    // A real detached group (kill(-pgid, 0) succeeds); the process table is faked to show its states.
    const leader = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = leader.pid!;
    const exited = new Promise((resolve) => leader.once("exit", resolve));
    try {
      expect(createMacosProcessGroup(() => ` ${pgid} 1 ${pgid} Z\n`).isAlive(pgid)).toBe(false);
      expect(createMacosProcessGroup(() => ` ${pgid} 1 ${pgid} Z\n ${pgid + 1} ${pgid} ${pgid} S\n`).isAlive(pgid)).toBe(true);
      expect(createMacosProcessGroup(() => null).isAlive(pgid)).toBe(true);
      expect(createMacosProcessGroup().isAlive(pgid)).toBe(true);
      expect(createMacosProcessGroup().signal(pgid, "terminate")).toBe(true);
    } finally {
      leader.kill("SIGKILL");
    }
    await exited;
    expect(createMacosProcessGroup().isAlive(pgid)).toBe(false);
    expect(createMacosProcessGroup().signal(pgid, "kill")).toBe(false);
  });
});

describe("shell", () => {
  it("is a Dock app: stays open with no windows, shows the app menu, a template tray icon and download updates", () => {
    expect(macosShell.quitWhenAllWindowsClosed).toBe(false);
    expect(macosShell.applicationMenu).toBe(true);
    expect(macosShell.trayIcon).toBe("template");
    expect(macosShell.appName({ productName: "SpaceBadger", legacyName: "@space/badger" })).toBe("SpaceBadger");
    expect(macosShell.hasDisplay({})).toBe(true);
    expect(macosShell.mpvWindow({ appId: "io.example", env: {} }).args).toEqual(["--gpu-api=vulkan", "--gpu-context=macvk"]);
  });
});
