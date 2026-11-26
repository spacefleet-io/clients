/**
 * @test-id PARROT-INGEST-IMPORT-RESUME-001
 * @req PAR-UP-13[parrot] @req RT-LIFE-04[parrot] @req UX-JOBS-02[parrot]
 * @level unit
 * @why RT-LIFE-04 / PAR-UP-13: an import's songs are jobs on the desktop's lasting job engine. Parrot quitting in the
 *      middle of an album stops the engine; the next start reopens the import and its jobs go on from where they
 *      were, and the import counts every song of the album, the ones done before the quit too. UX-JOBS-02: a song
 *      that failed while the import runs can be tried again from its row, and is then no longer counted as failed.
 * @covers packages/parrot-ingest/src/importJobs.ts
 */
import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createEngineV2, type EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import { createParrotImportSession, type ParrotImportOptions, type ParrotImportSession, type ParrotImportTransport } from "../src/importer";
import { PARROT_IMPORT_APP, registerParrotImportHandlers, runParrotImport } from "../src/importJobs";
import { testLog } from "./helpers";
import { createSlowServer, slowAlbumInfo, writeSlowAlbum, CHRIS_LINE } from "./slowServer";

const log = testLog("PARROT-INGEST-IMPORT-RESUME-001");
const SCALE = 0.05;

const sessionOptions = (dir: string, transport: ParrotImportTransport, extra: Partial<ParrotImportOptions> = {}): ParrotImportOptions => ({
  token: "token",
  userId: "user-chris",
  libraryKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  clientType: "parrot-desktop",
  transport,
  roots: [dir],
  readInfo: slowAlbumInfo,
  makeLightCopy: async (original) => randomBytes(Math.round(original.size / 4)),
  ...extra,
});

const openEngine = async (dbPath: string, session: () => ParrotImportSession, lightDir: string): Promise<EngineV2> => {
  const engine = createEngineV2({ dbPath, validateEvents: false, hostCpuCount: 4 });
  registerParrotImportHandlers(engine, async () => session(), (job) => path.join(lightDir, `${job.jobId}.light`));
  await engine.start();
  return engine;
};

describe("an import on the lasting job engine", () => {
  it("goes on after Parrot quits in the middle, counting the songs done before", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parrot-resume-"));
    try {
      const files = await writeSlowAlbum(dir, 12, 1_000_000);
      // Slower than the retry case: the quit has to come while most songs are still on their way.
      const server = createSlowServer(CHRIS_LINE, 0.5);
      const dbPath = path.join(dir, "jobs.sqlite");
      const importId = "import-1";

      // Parrot's first run: stopped once two songs are in.
      const { promise: twoIn, resolve: enough } = Promise.withResolvers<void>();
      const first = createParrotImportSession(files, {
        ...sessionOptions(dir, server.transport),
        onProgress: (progress) => {
          if (progress.done >= 2) enough();
        },
      });
      await first.open();
      const engineA = await openEngine(dbPath, () => first, dir);
      void runParrotImport({ engine: engineA, session: first, userId: "user-chris", importId, files, light: true }).catch(() => undefined);
      await twoIn;
      await engineA.stop();
      first.close();
      const publishedBefore = server.publishes();

      // The next start: the import's jobs, as the engine kept them, go on with a session reopened for them.
      const second = createParrotImportSession(files, sessionOptions(dir, server.transport));
      await second.open();
      const engineB = await openEngine(dbPath, () => second, dir);
      try {
        const { jobs } = await engineB.list({ app: PARROT_IMPORT_APP, groupId: importId });
        const unfinished = jobs.filter((job) => job.status !== "succeeded").length;
        log("resuming", { jobs: jobs.length, unfinished, publishedBefore });
        expect(jobs).toHaveLength(24);
        expect(unfinished).toBeGreaterThan(0);
        const result = await runParrotImport({ engine: engineB, session: second, userId: "user-chris", importId, files, light: true, resumed: jobs });
        log("resumed import ended", { imported: result.imported.length, skipped: result.skipped.length, failed: result.failed });
        expect(result.failed).toEqual([]);
        expect(result.imported.length + result.skipped.length).toBe(12);
        expect(result.imported).toEqual([...result.imported].sort());
      } finally {
        await engineB.stop();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("tries a failed song again from its row while the import runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parrot-retry-"));
    try {
      const files = await writeSlowAlbum(dir, 6, 200_000);
      const server = createSlowServer(CHRIS_LINE, SCALE);
      // The second song cannot be read until it is tried again (the drive came back, say).
      let readable = false;
      const session = createParrotImportSession(files, {
        ...sessionOptions(dir, server.transport),
        readInfo: async (file) => {
          if (file === files[1] && !readable) throw new Error("drive unplugged");
          return slowAlbumInfo(file);
        },
      });
      await session.open();
      const engine = await openEngine(path.join(dir, "jobs.sqlite"), () => session, dir);
      const retried: string[] = [];
      const unsubscribe = engine.subscribe((event) => {
        if (event.event !== "runtime.jobs.failed" || retried.includes(event.jobId)) return;
        retried.push(event.jobId);
        readable = true;
        void engine.retry(event.jobId);
      });
      try {
        const result = await runParrotImport({ engine, session, userId: "user-chris", importId: "import-2", files, light: true });
        log("import with a retried song ended", { retried, imported: result.imported.length, failed: result.failed });
        expect(retried.length).toBeGreaterThanOrEqual(1);
        expect(result.failed).toEqual([]);
        expect(result.imported).toEqual(files);
      } finally {
        unsubscribe();
        await engine.stop();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
