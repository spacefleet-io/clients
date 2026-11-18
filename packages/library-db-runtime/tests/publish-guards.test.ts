import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

// Suite-id: publish-guards
// Records the stubbed prepare() interactions so a failing test reveals which
// SQL the runtime asked for, in what order. The runtime touches: PRAGMA
// data_version, PRAGMA integrity_check, FROM media_items, FROM media_formats,
// FROM media_audio_tracks.
const dumpPublishGuardsSnapshot = (label: string, runtime: any, sqlCalls: string[]) => {
  try {
    console.error(`=== [publish-guards:${label}] snapshot ===`);
    console.error(`runtime.syncEnabled=${JSON.stringify(runtime?.syncEnabled)}`);
    console.error(`sql calls observed (${sqlCalls.length}):`);
    for (let i = 0; i < sqlCalls.length; i++) {
      console.error(`  [${i}] ${sqlCalls[i]}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-runtime-guards-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[publish-guards:setup] root=${root}`);
});

afterEach(async () => {
  console.info(`[publish-guards:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const buildRuntime = (
  prepare: (sql: string) => { all?: () => unknown[]; get?: () => unknown },
  sqlCalls: string[],
) => {
  const runtime = Object.create(LibraryDb.prototype) as any;
  runtime.syncEnabled = true;
  runtime.db = {
    prepare: (sql: string) => {
      sqlCalls.push(sql.replace(/\s+/g, " ").trim().slice(0, 200));
      return prepare(sql);
    },
  };
  const libraryDir = join(root, "library");
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(join(libraryDir, "library.sqlite"), Buffer.from("sqlite"));
  console.info(`[publish-guards:build] libraryDir=${libraryDir} written stub sqlite file`);
  return runtime;
};

describe("publish guards", () => {
  it("blocks publish when semantic orphan playback rows are detected", async () => {
    const sqlCalls: string[] = [];
    const runtime = buildRuntime((sql: string) => {
        if (sql.includes("PRAGMA integrity_check")) {
          return { all: () => [{ integrity_check: "ok" }] };
        }
        if (sql.includes("FROM media_items")) {
          return { get: () => ({ c: 0 }) };
        }
        if (sql.includes("FROM media_formats")) {
          return { get: () => ({ c: 1 }) };
        }
        if (sql.includes("FROM media_audio_tracks")) {
          return { get: () => ({ c: 0 }) };
        }
        return { get: () => ({ c: 0 }), all: () => [] };
    }, sqlCalls);

    console.info(`[publish-guards:orphan] calling ensurePublishableState("snapshot")`);
    try {
      const ok = await runtime.ensurePublishableState("snapshot");
      console.info(
        `[publish-guards:orphan] result=${ok} syncEnabled-after=${runtime.syncEnabled} ` +
          `sql-call-count=${sqlCalls.length}`,
      );
      expect(ok).toBe(false);
      expect(runtime.syncEnabled).toBe(false);
    } catch (err) {
      console.error(`[publish-guards:orphan] assertion failed`);
      dumpPublishGuardsSnapshot("orphan-failure", runtime, sqlCalls);
      throw err;
    }
  });

  it("blocks publish when sqlite integrity check fails", async () => {
    const sqlCalls: string[] = [];
    const runtime = buildRuntime((sql: string) => {
        if (sql.includes("PRAGMA integrity_check")) {
          return { all: () => [{ integrity_check: "corrupt" }] };
        }
        return { get: () => ({ c: 0 }), all: () => [] };
    }, sqlCalls);

    console.info(`[publish-guards:integrity] calling ensurePublishableState("ops")`);
    try {
      const ok = await runtime.ensurePublishableState("ops");
      console.info(
        `[publish-guards:integrity] result=${ok} syncEnabled-after=${runtime.syncEnabled} ` +
          `sql-call-count=${sqlCalls.length}`,
      );
      expect(ok).toBe(false);
      expect(runtime.syncEnabled).toBe(false);
    } catch (err) {
      console.error(`[publish-guards:integrity] assertion failed`);
      dumpPublishGuardsSnapshot("integrity-failure", runtime, sqlCalls);
      throw err;
    }
  });
});
