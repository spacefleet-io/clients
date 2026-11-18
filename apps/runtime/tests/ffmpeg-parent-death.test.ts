/**
 * #25 P7 — an encoder ffmpeg must die with the process that spawned it.
 *
 * Ultimate baseline b51ea3c4 (shard-2): after a runtime-kill, an app-quit or
 * an mpv-kill case, 7 encoders kept running at full CPU with ppid 1, because
 * `spawnCommand` (packages/ffmpeg/src/index.ts) spawned them with no
 * parent-death handling and the #123 drain only runs on SIGTERM. A SIGKILLed
 * runtime cannot clean up after itself, so the kernel has to: on Linux the
 * child is started with PR_SET_PDEATHSIG=SIGKILL.
 *
 * The test runs a real parent process (Bun, the runtime's own path, and Node
 * for the `node:child_process` path) that starts a long "encode" through
 * `runFfmpeg` with a fake ffmpeg (`exec sleep 300`, so no ffmpeg is needed on
 * the runner), SIGKILLs that parent, and expects the child gone within 3 s.
 *
 * @bugfix @regression-proof
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Real waits on purpose: the test observes the kernel reaping a real process
// tree (/proc polling), which fake timers cannot drive.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFfmpegTask } from "@space/ffmpeg";

const SUITE = "ffmpeg-parent-death";
const FFMPEG_SRC = resolve(__dirname, "../../../packages/ffmpeg/src/index.ts");
const DEATH_DEADLINE_MS = 3_000;

const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}:${phase}] ${JSON.stringify(data)}`);

/** `null` when the pid is gone; zombies count as gone (they run no code). */
const procState = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "?";
    return state === "Z" || state === "X" ? null : state;
  } catch {
    return null;
  }
};

const procCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
};

const bunOnPath = spawnSync("sh", ["-c", "command -v bun"]).status === 0;

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) {
    try {
      cleanup.pop()?.();
    } catch {
      // best effort
    }
  }
});

const PARENT_BODY = (importSpec: string, fakeFfmpeg: string) => `
import { runFfmpeg } from ${JSON.stringify(importSpec)};
const run = runFfmpeg(["-i", "/nonexistent/source.mkv", "-f", "null", "-"], {
  ffmpegPath: ${JSON.stringify(fakeFfmpeg)},
  progress: { enabled: false },
  onSpawn: ({ pid }) => console.log(JSON.stringify({ childPid: pid, parentPid: process.pid })),
});
run.then(
  (res) => console.log(JSON.stringify({ exited: res.code })),
  (err) => console.log(JSON.stringify({ rejected: String(err) }))
);
setInterval(() => {}, 60_000);
`;

type Variant = { name: string; prepare: (dir: string, fake: string) => { cmd: string; args: string[] } };

const variants: Variant[] = [
  {
    name: "bun (runtime path: Bun.spawn)",
    prepare: (dir, fake) => {
      const parent = join(dir, "parent.ts");
      writeFileSync(parent, PARENT_BODY(FFMPEG_SRC, fake));
      return { cmd: "bun", args: [parent] };
    },
  },
  {
    name: "node (node:child_process path)",
    prepare: (dir, fake) => {
      const bundle = join(dir, "ffmpeg.mjs");
      const built = spawnSync("bun", ["build", FFMPEG_SRC, "--target=node", "--format=esm", `--outfile=${bundle}`], {
        encoding: "utf8",
      });
      log("node-bundle", { status: built.status, stderr: built.stderr.slice(-500) });
      expect(built.status).toBe(0);
      const parent = join(dir, "parent.mjs");
      writeFileSync(parent, PARENT_BODY(bundle, fake));
      return { cmd: process.execPath, args: [parent] };
    },
  },
];

describe.skipIf(process.platform !== "linux" || !bunOnPath)(
  "@bugfix @regression-proof ffmpeg dies with its parent (#25 P7)",
  () => {
    it.each(variants)("SIGKILL of the parent kills the encoder within 3 s — $name", async (variant) => {
      const dir = mkdtempSync(join(tmpdir(), "sf-pdeath-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const fake = join(dir, "ffmpeg");
      writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n");
      chmodSync(fake, 0o755);
      const { cmd, args } = variant.prepare(dir, fake);
      log("spawn-parent", { variant: variant.name, cmd, args });

      const parent: ChildProcess = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      cleanup.push(() => parent.kill("SIGKILL"));
      let stdout = "";
      let stderr = "";
      parent.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
      parent.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));

      // Wait for the child pid, then for the fake ffmpeg to have exec'd
      // `sleep` (so the encoder is truly running, not mid-spawn).
      let childPid: number | null = null;
      const startDeadline = Date.now() + 20_000;
      while (Date.now() < startDeadline) {
        const m = /"childPid":(\d+)/.exec(stdout);
        if (m) {
          childPid = Number(m[1]);
          if (procCmdline(childPid)?.startsWith("sleep 300")) break;
        }
        await sleep(25);
      }
      log("child-started", { childPid, cmdline: childPid ? procCmdline(childPid) : null, stdout, stderr: stderr.slice(-800) });
      expect(childPid).not.toBeNull();
      const pid = childPid as number;
      cleanup.push(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      });
      expect(procCmdline(pid)).toMatch(/^sleep 300/);

      log("kill-parent", { parentPid: parent.pid });
      const killedAt = Date.now();
      parent.kill("SIGKILL");

      let state = procState(pid);
      while (state !== null && Date.now() - killedAt < DEATH_DEADLINE_MS) {
        await sleep(25);
        state = procState(pid);
      }
      const elapsedMs = Date.now() - killedAt;
      log("after-kill", { childPid: pid, state, elapsedMs, cmdline: procCmdline(pid), stderr: stderr.slice(-800) });
      expect(state, `ffmpeg child ${pid} still alive ${elapsedMs} ms after its parent was SIGKILLed`).toBeNull();
    }, 40_000);

    // PR #150 review: spawnCommand now awaits the setpriv probe before the
    // child exists, so a cancel() issued right after createFfmpegTask found
    // no kill handle and was a silent no-op: the encode ran to completion.
    it("a task cancelled before its child spawned kills the child on spawn", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sf-pdeath-cancel-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const fake = join(dir, "ffmpeg");
      writeFileSync(fake, "#!/bin/sh\nexec sleep 300\n");
      chmodSync(fake, 0o755);
      const spawned: Array<number | undefined> = [];
      const task = createFfmpegTask(["-i", "/nonexistent/source.mkv", "-f", "null", "-"], {
        ffmpegPath: fake,
        progress: { enabled: false },
        onSpawn: ({ pid }) => {
          log("cancel-early:spawned", { pid });
          spawned.push(pid);
        },
      });
      const startedAt = Date.now();
      task.cancel();
      log("cancel-early:cancelled", { status: task.status });
      const outcome = await task.promise.then(
        (res) => ({ resolved: res.code }),
        (err: unknown) => ({ rejected: err instanceof Error ? err.message : String(err) })
      );
      const elapsedMs = Date.now() - startedAt;
      const pid = spawned[0];
      log("cancel-early:outcome", { outcome, elapsedMs, pid, state: pid ? procState(pid) : null, status: task.status });
      // The node path reads a signal exit as code 0 and the task then reports
      // "finished"; callers go through runFfmpegWithSignal, which maps an
      // aborted run to CANCELLED. What matters here: the child is dead, now.
      expect(spawned).toHaveLength(1);
      expect(pid === undefined ? null : procState(pid)).toBeNull();
      expect(elapsedMs).toBeLessThan(DEATH_DEADLINE_MS);
    }, 10_000);
  }
);
