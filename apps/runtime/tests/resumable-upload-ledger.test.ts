/**
 * @req RT-JOBS-04
 * Upload completion is recorded with one appended ledger line per part, not a
 * rewrite of the whole job state (issue #671, R7: a 2 h film wrote ~4.2 GB of
 * job_state.json). A kill mid-upload must still resume from the ledger.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, promises as fsp, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResumableJobStateStore,
  UPLOAD_LEDGER_FILE,
  loadJobStateSync,
  type JobState,
} from "@space/content-core";

const roots: string[] = [];
const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "sf-upload-ledger-"));
  roots.push(root);
  console.info(`[upload-ledger:setup] root=${root}`);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const part = (i: number) => ({
  partNumber: 0,
  etag: `obj-${i}`,
  sizeBytes: 1000 + i,
  checksum: `sum-${i}`,
  path: `/tmp/seg-${i}.m4s`,
});

const seed = async (jobDir: string, segments: number) => {
  const store = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/in.mkv", userId: "u" });
  const output = store.ensureOutput("video-1080p", "video", 4);
  output.init = { path: "/tmp/init.mp4", uploaded: false };
  for (let i = 0; i < segments; i++) {
    output.segments.push({ path: `/tmp/seg-${i}.m4s`, uploaded: false, startSeconds: i * 4 });
  }
  await store.save();
  return store;
};

describe("upload ledger", () => {
  it("records a part with one appended line and leaves job_state.json untouched", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 50);
    const statePath = join(jobDir, "job_state.json");
    const stateBefore = readFileSync(statePath, "utf8");

    for (let i = 0; i < 50; i++) await store.recordCompletedPart("video-1080p", part(i));

    const ledger = readFileSync(join(jobDir, UPLOAD_LEDGER_FILE), "utf8");
    console.info(
      `[upload-ledger:append] ledger lines=${ledger.trim().split("\n").length} bytes=${ledger.length} stateBytes=${stateBefore.length}`
    );
    expect(ledger.trim().split("\n")).toHaveLength(50);
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
  });

  it("@bugfix @regression-proof writes bytes proportional to parts, not parts x state size", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 1500);
    const stateBytes = statSync(join(jobDir, "job_state.json")).size;

    let written = 0;
    const realWrite = fsp.writeFile.bind(fsp);
    const realAppend = fsp.appendFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
      written += Buffer.byteLength(String(args[1]));
      return realWrite(...args);
    });
    vi.spyOn(fsp, "appendFile").mockImplementation(async (...args: Parameters<typeof fsp.appendFile>) => {
      written += Buffer.byteLength(String(args[1]));
      return realAppend(...args);
    });

    for (let i = 0; i < 1500; i++) await store.recordCompletedPart("video-1080p", part(i));
    console.info(
      `[upload-ledger:bytes] 1500 parts wrote ${written} bytes; job_state.json is ${stateBytes} bytes; a whole-state rewrite per part would write ${stateBytes * 1500}`
    );
    // 1500 x ~150 B ledger lines vs 1500 x stateBytes (~170 kB compact) before.
    expect(written).toBeLessThan(stateBytes * 5);
  });

  it("reopening replays the ledger: flags, key, size and checksum are restored, then the ledger is folded in", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 10);
    for (const i of [0, 1, 2, 7]) await store.recordCompletedPart("video-1080p", part(i));
    await store.recordCompletedPart("video-1080p", {
      partNumber: 0,
      etag: "init-key",
      sizeBytes: 77,
      path: "/tmp/init.mp4",
    });

    const reopened = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/in.mkv", userId: "u" });
    const output = reopened.getOutput("video-1080p")!;
    console.info(
      `[upload-ledger:replay] uploaded=${JSON.stringify(output.segments.map((s) => s.uploaded === true))} init=${JSON.stringify(output.init)}`
    );
    expect(output.segments.filter((s) => s.uploaded).map((s) => s.key)).toEqual(["obj-0", "obj-1", "obj-2", "obj-7"]);
    expect(output.segments[7]).toMatchObject({ uploaded: true, key: "obj-7", sizeBytes: 1007, checksum: "sum-7" });
    expect(output.init).toMatchObject({ uploaded: true, key: "init-key", sizeBytes: 77 });
    expect(output.completedParts).toHaveLength(1);
    // open() saved the folded state and emptied the ledger.
    await expect(fsp.stat(join(jobDir, UPLOAD_LEDGER_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    const onDisk = JSON.parse(readFileSync(join(jobDir, "job_state.json"), "utf8")) as JobState;
    expect(onDisk.outputs[0]!.segments[7]).toMatchObject({ uploaded: true, key: "obj-7" });
  });

  it("a torn last line (kill mid-append) loses only that entry", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 5);
    for (const i of [0, 1, 2]) await store.recordCompletedPart("video-1080p", part(i));
    appendFileSync(join(jobDir, UPLOAD_LEDGER_FILE), '{"outputId":"video-1080p","part":{"partNumber":0,"eta');

    const reopened = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/in.mkv", userId: "u" });
    const keys = reopened.getOutput("video-1080p")!.segments.filter((s) => s.uploaded).map((s) => s.key);
    console.info(`[upload-ledger:torn] keys after replay=${JSON.stringify(keys)}`);
    expect(keys).toEqual(["obj-0", "obj-1", "obj-2"]);
  });

  it("save() empties the ledger and an append queued after it survives", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 5);
    await store.recordCompletedPart("video-1080p", part(0));
    const pending = [
      store.save(),
      store.recordCompletedPart("video-1080p", { ...part(1) }),
    ];
    await Promise.all(pending);
    const ledger = readFileSync(join(jobDir, UPLOAD_LEDGER_FILE), "utf8").trim().split("\n");
    console.info(`[upload-ledger:order] ledger after save+append: ${JSON.stringify(ledger)}`);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toContain("obj-1");
  });

  it("loadJobStateSync merges the ledger into the state read from disk", async () => {
    const jobDir = join(createRoot(), "job");
    const store = await seed(jobDir, 4);
    await store.recordCompletedPart("video-1080p", part(3));
    const state = loadJobStateSync<JobState>(join(jobDir, "job_state.json"))!;
    expect(state.outputs[0]!.segments[3]).toMatchObject({ uploaded: true, key: "obj-3" });
    expect(state.outputs[0]!.segments[0]!.uploaded).toBe(false);
    expect(loadJobStateSync(join(jobDir, "missing.json"))).toBeNull();
  });

  /**
   * @bugfix @regression-proof kill -9 mid-upload: every part whose record
   * call had resolved (ACK printed) must be restored on the next open.
   */
  it("a SIGKILL mid-upload resumes with every acknowledged part restored", async () => {
    const jobDir = join(createRoot(), "job");
    const fixture = join(import.meta.dirname, "fixtures", "upload-ledger-child.ts");
    const child = spawn("bun", [fixture, jobDir, "3000"], { stdio: ["ignore", "pipe", "inherit"] });
    let lastAck = -1;
    let buffer = "";
    const killed = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("ACK ")) lastAck = Number(line.slice(4));
          if (line === "DONE") reject(new Error("child finished before it was killed"));
          if (lastAck >= 400 && !child.killed) {
            child.kill("SIGKILL");
          }
        }
      });
      child.on("close", () => resolve());
      child.on("error", reject);
    });
    await killed;
    console.info(`[upload-ledger:kill] child SIGKILLed after ACK ${lastAck}`);
    expect(lastAck).toBeGreaterThanOrEqual(400);

    const reopened = await ResumableJobStateStore.open({ jobDir, inputPath: "/tmp/in.mkv", userId: "u" });
    const segments = reopened.getOutput("video-1080p")!.segments;
    const restored = segments.filter((s) => s.uploaded).length;
    console.info(`[upload-ledger:kill] restored=${restored} segments flagged uploaded (acked up to ${lastAck})`);
    for (let i = 0; i <= lastAck; i++) {
      expect(segments[i], `segment ${i}`).toMatchObject({ uploaded: true, key: `obj-${i}`, sizeBytes: 1000 + i });
    }
    // Nothing beyond what the child could have started: at most one unacknowledged append.
    expect(restored).toBeLessThanOrEqual(lastAck + 2);
  }, 60_000);
});
