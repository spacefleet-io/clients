/**
 * @bugfix @regression-proof P26 (ultimate confirm run 2026-10-07, shard-2 job
 * ec1d9262, case x033 disruption=runtime-kill): the runtime was SIGKILLed just
 * after spawning a 360p DASH encode. The orphaned ffmpeg kept writing the
 * outputs dir; the restarted runtime re-ran the encode into the same dir and
 * died with `failed to rename seg-00001.m4s.tmp … No such file` because the
 * orphan renamed the temp segment out from under it (ffmpeg count=2 with a
 * format lane cap of 1). `reclaimOrphanEncoder` must kill such an orphan —
 * only when it is verifiably the same encode — and wipe the dir, logging why.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENCODER_LEASE_FILE,
  reclaimOrphanEncoder,
  releaseEncoderLease,
  writeEncoderLease,
  type EncoderLease,
  type EncoderLeaseDeps,
} from "../src/encoderLease";

const SUITE = "encoder-lease";
const OWN_PID = 5000;
const DEAD_RUNTIME = 4000;
const ORPHAN = 4100;
const MPD = "/transcode/u1/ec1d9262/outputs/video-360p-h264/manifest.mpd";
const DIR = "/transcode/u1/ec1d9262/outputs/video-360p-h264";

type Harness = {
  deps: Partial<EncoderLeaseDeps>;
  files: Map<string, string>;
  alive: Set<number>;
  killed: number[];
  resets: string[];
  logs: Array<{ level: string; message: string; data: Record<string, unknown> }>;
};

const makeHarness = (lease: EncoderLease | string | null, opts: { commandLine?: string | null } = {}): Harness => {
  const files = new Map<string, string>();
  if (lease !== null) files.set(join(DIR, ENCODER_LEASE_FILE), typeof lease === "string" ? lease : JSON.stringify(lease));
  const alive = new Set<number>([OWN_PID, ORPHAN]);
  const killed: number[] = [];
  const resets: string[] = [];
  const logs: Harness["logs"] = [];
  const deps: Partial<EncoderLeaseDeps> = {
    ownPid: OWN_PID,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text) => {
      files.set(path, text);
    },
    remove: (path) => {
      files.delete(path);
    },
    isAlive: (pid) => alive.has(pid),
    readCommandLine: async () => ("commandLine" in opts ? (opts.commandLine ?? null) : `/usr/bin/ffmpeg -y -i in.mkv -f dash ${MPD}`),
    kill: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
    sleep: async () => {},
    resetDir: async (dir) => {
      resets.push(dir);
    },
    info: (message, data) => {
      console.info(`[${SUITE}] ${message}`, data);
      logs.push({ level: "info", message, data });
    },
    warn: (message, data) => {
      console.info(`[${SUITE}] (warn) ${message}`, data);
      logs.push({ level: "warn", message, data });
    },
  };
  return { deps, files, alive, killed, resets, logs };
};

const orphanLease: EncoderLease = { pid: ORPHAN, ownerPid: DEAD_RUNTIME, mpdPath: MPD, startedAt: "2026-10-07T15:58:13.000Z" };

const dump = (label: string, h: Harness) =>
  console.error(
    `=== [${SUITE}:${label}] snapshot === killed=${JSON.stringify(h.killed)} resets=${JSON.stringify(h.resets)} files=${JSON.stringify([...h.files])} logs=${JSON.stringify(h.logs)}`
  );

describe(`${SUITE} @bugfix @regression-proof`, () => {
  it("kills a verified orphan encoder of a dead runtime and wipes the outputs dir with a logged reason", async () => {
    const h = makeHarness(orphanLease);
    try {
      expect(await reclaimOrphanEncoder(DIR, h.deps)).toBe("reaped");
      expect(h.killed).toEqual([ORPHAN]);
      expect(h.resets).toEqual([DIR]);
      expect(h.logs.map((l) => l.message)).toContain("[mediaProcessor] reaped orphan encoder");
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          message: "[mediaProcessor] removing outputs dir",
          data: expect.objectContaining({ reason: "orphan-encoder-reaped", outputDir: DIR, pid: ORPHAN }),
        })
      );
    } catch (err) {
      dump("reaped", h);
      throw err;
    }
  });

  it.each([
    ["no lease", null, {}, "no-lease"],
    ["unreadable lease", "{not json", {}, "invalid-lease"],
    ["lease of this runtime", { ...orphanLease, ownerPid: OWN_PID }, {}, "own-lease"],
    ["identity cannot be read (UNSUPPORTED)", orphanLease, { commandLine: null }, "unsupported"],
    ["pid reused by another program", orphanLease, { commandLine: "/usr/bin/vim notes.txt" }, "identity-mismatch"],
  ] as const)("never kills anything for %s", async (label, lease, opts, outcome) => {
    const h = makeHarness(lease as EncoderLease | string | null, opts);
    try {
      expect(await reclaimOrphanEncoder(DIR, h.deps)).toBe(outcome);
      expect(h.killed).toEqual([]);
      expect(h.resets).toEqual([]);
      if (outcome === "unsupported") {
        expect(h.logs.some((l) => l.message.includes("UNSUPPORTED"))).toBe(true);
      }
    } catch (err) {
      dump(label, h);
      throw err;
    }
  });

  it("leaves a live owner's encoder alone and drops a stale lease whose encoder exited", async () => {
    const liveOwner = makeHarness(orphanLease);
    liveOwner.alive.add(DEAD_RUNTIME);
    const stale = makeHarness(orphanLease);
    stale.alive.delete(ORPHAN);
    try {
      expect(await reclaimOrphanEncoder(DIR, liveOwner.deps)).toBe("owner-alive");
      expect(liveOwner.killed).toEqual([]);
      expect(await reclaimOrphanEncoder(DIR, stale.deps)).toBe("encoder-gone");
      expect(stale.killed).toEqual([]);
      expect(stale.files.size).toBe(0);
    } catch (err) {
      dump("live-owner", liveOwner);
      dump("stale", stale);
      throw err;
    }
  });

  it("release only drops the lease of the encoder that wrote it", () => {
    const h = makeHarness(null);
    writeEncoderLease(DIR, 7001, MPD, h.deps);
    const leasePath = join(DIR, ENCODER_LEASE_FILE);
    expect(JSON.parse(h.files.get(leasePath)!)).toMatchObject({ pid: 7001, ownerPid: OWN_PID, mpdPath: MPD });
    releaseEncoderLease(DIR, 9999, h.deps);
    expect(h.files.has(leasePath)).toBe(true);
    releaseEncoderLease(DIR, 7001, h.deps);
    expect(h.files.has(leasePath)).toBe(false);
  });
});

/**
 * Real processes, real filesystem: the "dead runtime" is a child that already
 * exited, the "orphan encoder" is a live node process whose argv carries the
 * manifest path (as ffmpeg's does). Command-line identity is read from /proc,
 * so this runs on Linux only; darwin/win32 use `ps` / CIM (not exercised here).
 * The `setTimeout` in the children only keeps them alive (no test-side wait).
 */
describe.skipIf(process.platform !== "linux")(`${SUITE} real processes`, () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("reaps a live orphan writing the outputs dir and leaves an empty dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-encoder-lease-"));
    const outputDir = join(root, "outputs", "video-360p-h264");
    mkdirSync(outputDir, { recursive: true });
    const mpdPath = join(outputDir, "manifest.mpd");
    writeFileSync(join(outputDir, "seg-00001.m4s.tmp"), "partial");

    const deadRuntime = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(deadRuntime, "exit");
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", mpdPath], { stdio: "ignore" });
    cleanups.push(() => {
      try {
        process.kill(orphan.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(root, { recursive: true, force: true });
    });
    const exited = once(orphan, "exit");
    writeFileSync(
      join(outputDir, ENCODER_LEASE_FILE),
      JSON.stringify({ pid: orphan.pid, ownerPid: deadRuntime.pid, mpdPath, startedAt: new Date().toISOString() })
    );
    console.info(`[${SUITE}:real] orphan pid=${orphan.pid} dead runtime pid=${deadRuntime.pid} dir=${outputDir}`);

    const outcome = await reclaimOrphanEncoder(outputDir);
    console.info(`[${SUITE}:real] outcome=${outcome}`);
    expect(outcome).toBe("reaped");
    expect((await exited)[1]).toBe("SIGKILL");
    expect(existsSync(outputDir)).toBe(true);
    expect(existsSync(join(outputDir, "seg-00001.m4s.tmp"))).toBe(false);
    expect(existsSync(join(outputDir, ENCODER_LEASE_FILE))).toBe(false);
  });

  // #25: under the `pause` playback policy a transcode is frozen (SIGSTOP). If
  // the runtime dies while it is frozen, the next boot must still reap it: a
  // stopped process ignores SIGTERM but not SIGKILL. `vi.waitFor` polls /proc
  // for the real kernel state of the real child; there is nothing to fake.
  it("reaps an orphan encoder that was frozen by the playback gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-encoder-lease-"));
    const outputDir = join(root, "outputs", "video-360p-h264");
    mkdirSync(outputDir, { recursive: true });
    const mpdPath = join(outputDir, "manifest.mpd");
    const deadRuntime = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(deadRuntime, "exit");
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", mpdPath], { stdio: "ignore" });
    cleanups.push(() => {
      try {
        process.kill(orphan.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(root, { recursive: true, force: true });
    });
    const exited = once(orphan, "exit");
    writeFileSync(
      join(outputDir, ENCODER_LEASE_FILE),
      JSON.stringify({ pid: orphan.pid, ownerPid: deadRuntime.pid, mpdPath, startedAt: new Date().toISOString() })
    );
    process.kill(orphan.pid!, "SIGSTOP");
    await vi.waitFor(() => {
      const status = readFileSync(`/proc/${orphan.pid}/status`, "utf8");
      expect(status).toMatch(/^State:\s+T/m);
    });

    const outcome = await reclaimOrphanEncoder(outputDir);
    console.info(`[${SUITE}:frozen] outcome=${outcome}`);
    expect(outcome).toBe("reaped");
    expect((await exited)[1]).toBe("SIGKILL");
    expect(existsSync(join(outputDir, ENCODER_LEASE_FILE))).toBe(false);
  });

  it("does not kill a live process whose command line is not the leased encode", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-encoder-lease-"));
    const outputDir = join(root, "video-720p-h264");
    mkdirSync(outputDir, { recursive: true });
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    cleanups.push(() => {
      try {
        process.kill(bystander.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(root, { recursive: true, force: true });
    });
    const deadRuntime = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(deadRuntime, "exit");
    writeFileSync(
      join(outputDir, ENCODER_LEASE_FILE),
      JSON.stringify({
        pid: bystander.pid,
        ownerPid: deadRuntime.pid,
        mpdPath: join(outputDir, "manifest.mpd"),
        startedAt: new Date().toISOString(),
      })
    );
    expect(await reclaimOrphanEncoder(outputDir)).toBe("identity-mismatch");
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
  });
});
