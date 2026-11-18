// @bugfix @regression-proof issue #25 P7 — progress lost across a hard kill.
//
// pending_ops.json (unsent ops, incl. every playback-progress save) and the
// cache DB (library.sqlite) are rewritten ~2x/s during playback. They were
// written in place with writeFileSync (truncate, then write), so a hard kill
// (runtime health-kill, crash) landing mid-write left a truncated file:
// loadPendingOps then dropped every unsent op, and a torn cache DB failed to
// open, which wipes the local cache and pending state on the next open.
// The fix writes a sibling temp file and renames it over the target.
//
// The kill is simulated deterministically: the next write to the target's
// directory writes half the bytes and throws, like a process dying mid-write.
import * as realFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const LOG = "[library-files-survive-torn-write]";
const realFsSnapshot = { ...realFs };
let tearNextWrite = false;

mock.module("node:fs", () => ({
  ...realFsSnapshot,
  writeFileSync: (path: realFs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: realFs.WriteFileOptions) => {
    if (tearNextWrite && typeof path === "string") {
      tearNextWrite = false;
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      realFsSnapshot.writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
      console.info(`${LOG} simulated kill mid-write path=${path} wroteBytes=${Math.floor(bytes.length / 2)}/${bytes.length}`);
      throw new Error("SIMULATED_KILL_MID_WRITE");
    }
    return realFsSnapshot.writeFileSync(path, data, options);
  },
}));

// Imported after the fs mock is registered (the mock must be in place when
// the storage module binds its node:fs imports).
const storage = await import("../src/libraryDbStorage");

afterAll(() => {
  mock.module("node:fs", () => realFsSnapshot);
});

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-torn-write-"));
  process.env.SF_USER_DATA_PATH = root;
  tearNextWrite = false;
  console.info(`${LOG} setup root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const op = (id: string, pct: number) => ({
  id,
  createdAt: "2026-10-06T00:00:00.000Z",
  type: "media.progress",
  payload: { mediaId: "m1", progressPct: pct, lastWatchedAt: "x", updatedAt: "x" },
});

describe("library storage writes survive a kill mid-write (@bugfix @regression-proof issue #25 P7)", () => {
  it("pending_ops.json keeps the last complete queue when a rewrite is torn", async () => {
    const committed = [op("a", 47.4801), op("b", 48.1)];
    await storage.savePendingOps(committed);
    console.info(`${LOG} committed queue=${JSON.stringify(committed.map((o) => o.payload.progressPct))}`);

    tearNextWrite = true;
    await expect(storage.savePendingOps([...committed, op("c", 50.8)])).rejects.toThrow("SIMULATED_KILL_MID_WRITE");

    const reloaded = await storage.loadPendingOps();
    console.info(`${LOG} reloaded after torn write ids=${JSON.stringify(reloaded.map((o) => o.id))}`);
    expect(reloaded.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("the cache DB file keeps its last complete bytes when a rewrite is torn", () => {
    const target = storage.getCacheDbPath();
    storage.ensureLibraryDir();
    const complete = new Uint8Array(4096).fill(7);
    storage.writeFileAtomicSync(target, complete);

    tearNextWrite = true;
    expect(() => storage.writeFileAtomicSync(target, new Uint8Array(8192).fill(9))).toThrow("SIMULATED_KILL_MID_WRITE");

    const onDisk = new Uint8Array(readFileSync(target));
    console.info(`${LOG} cache bytes after torn write length=${onDisk.length} first=${onDisk[0]}`);
    expect(onDisk.length).toBe(4096);
    expect(onDisk.every((b) => b === 7)).toBe(true);
  });
});
