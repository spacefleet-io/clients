/**
 * @req RT-SEC-05[runtime]
 *
 * The runtime keeps the library key and the backend token in memory only. The
 * offline-download job payload is persisted by the jobs engine in
 * `runtime_jobs.db` (job row, step row, created-event row), so it must carry
 * neither, and rows written by older builds must be scrubbed at startup.
 *
 * The scan reads the raw bytes of every file in the data dir (db, -wal, -shm):
 * a key in any form (base64, raw bytes, hex, base64url) or the token is a failure.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBadgerOfflineSubmitHandler } from "../src/modules/badger/offlineDownload";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createEngineV2, type EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import { createSqliteRuntimeJobsStore } from "@space/runtime-jobs-engine/sqliteStore";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "runtime-jobs-secret-at-rest";

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
const KEY_BASE64 = KEY_BYTES.toString("base64");
const TOKEN = "tok_runtime_secret_at_rest_0123456789";

const keyForms = (): Array<{ form: string; needle: Buffer }> => [
  { form: "base64", needle: Buffer.from(KEY_BASE64) },
  { form: "base64url", needle: Buffer.from(KEY_BYTES.toString("base64url")) },
  { form: "hex", needle: Buffer.from(KEY_BYTES.toString("hex")) },
  { form: "raw", needle: KEY_BYTES },
  { form: "token", needle: Buffer.from(TOKEN) },
  { form: "field-name", needle: Buffer.from("libraryKeyBase64") },
];

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });

/** Names of the files (and the form) in `dir` whose bytes contain the key or the token. */
const scanForSecrets = (dir: string): string[] => {
  const hits: string[] = [];
  for (const file of listFiles(dir)) {
    const bytes = readFileSync(file);
    for (const { form, needle } of keyForms()) {
      if (bytes.includes(needle)) hits.push(`${file.slice(dir.length)}:${form}`);
    }
  }
  return hits;
};

const movieDetails = () => ({
  id: "media-movie-1",
  title: "Test Movie",
  year: "2026",
  type: "movie",
  files: [{ id: "file-movie-1", filename: "/disk/movie.mkv", season: null, episode: null }],
  formats: [
    {
      id: "format-1080",
      fileId: "file-movie-1",
      quality: "1080p",
      initKey: "movie-1080-init",
      initSize: 1024,
      chunks: [{ key: "movie-1080-chunk-0", sizeBytes: 4096, startSeconds: null }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
  episodes: [],
});

const libraryDb = {
  isOpen: () => true,
  call: vi.fn(async (method: string) => (method === "getMediaDetails" ? movieDetails() : null)),
  listLocalDownloads: vi.fn(async () => []),
} as unknown as BadgerLibraryDbService;

/** What the earlier build submitted: the key and the token inside the payload. */
const legacyJob = (): IngestJobRecord => {
  const now = new Date().toISOString();
  return {
    jobId: "legacy-offline-1",
    app: "badger",
    kind: "download",
    lane: "upload",
    variant: null,
    priority: 70,
    parentJobIds: [],
    groupId: "media-movie-1",
    mediaId: "media-movie-1",
    status: "queued",
    stageCode: "queued",
    stageLabel: "Queued",
    progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
    progressPct: 0,
    outputs: {},
    errorCode: null,
    errorMessage: null,
    retryable: false,
    cancelRequested: false,
    dedupeKey: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    dismissedAt: null,
    uploadSpeedBytesPerSec: null,
    payload: {
      fileId: "file-movie-1",
      mediaId: "media-movie-1",
      quality: "1080p",
      formatId: "format-1080",
      container: "mkv",
      libraryKeyBase64: KEY_BASE64,
      token: TOKEN,
      expectedBytes: 4096,
      filename: "Test Movie (2026)",
    },
  } as IngestJobRecord;
};

describe(`[@req RT-SEC-05[runtime]] ${SUITE}`, () => {
  let dataDir: string;
  let dbPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spacefleet-jobs-secret-"));
    dbPath = join(dataDir, "runtime_jobs.db");
    console.info(`[${SUITE}:setup] dataDir=${dataDir}`);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A queued job stays queued: this handler parks until the engine stops. */
  const parkOfflineSteps = (engine: EngineV2) =>
    engine.registerHandler(
      "offline_download",
      ({ signal }) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    );

  it("an offline download submit leaves no key and no token anywhere in the data dir", async () => {
    const engine = createEngineV2({ dbPath });
    parkOfflineSteps(engine);
    await engine.start();
    const submit = createBadgerOfflineSubmitHandler({
      engine,
      libraryDb,
      resolveToken: () => TOKEN,
      resolveLibraryKey: () => KEY_BASE64,
      resolveOfflineDir: () => join(dataDir, "offline"),
    });
    const result = await submit({
      mediaIds: ["media-movie-1"],
      quality: "1080p",
      container: "mkv",
      skipAlreadyLocal: true,
    });
    if ("errorCode" in result) throw new Error(`submit failed: ${JSON.stringify(result)}`);
    expect(result.submitted).toHaveLength(1);

    const stored = await engine.get(result.submitted[0]!.jobId);
    expect(stored?.job.kind).toBe("download");
    expect(stored?.job.payload).toMatchObject({ fileId: "file-movie-1", formatId: "format-1080" });
    expect(JSON.stringify(stored)).not.toContain(KEY_BASE64);

    // Live: the commit is in the -wal next to the db.
    const live = scanForSecrets(dataDir);
    console.info(`[${SUITE}:live-scan] files=${listFiles(dataDir).length} hits=${JSON.stringify(live)}`);
    expect(live).toEqual([]);

    await engine.stop();
    const stopped = scanForSecrets(dataDir);
    console.info(`[${SUITE}:stopped-scan] hits=${JSON.stringify(stopped)}`);
    expect(stopped).toEqual([]);
  });

  it("the startup scrub removes the key and the token from the rows of an older build", async () => {
    // Seed like the older build did: submit a job whose payload carries both.
    const seed = createEngineV2({ dbPath });
    parkOfflineSteps(seed);
    await seed.start();
    await seed.submit(legacyJob());
    await seed.stop();
    const before = scanForSecrets(dataDir);
    console.info(`[${SUITE}:legacy-seeded] hits=${JSON.stringify(before)}`);
    // The seed really is the legacy shape: key and token are on disk.
    expect(before.some((hit) => hit.endsWith(":base64"))).toBe(true);
    expect(before.some((hit) => hit.endsWith(":token"))).toBe(true);

    // Boot: opening the store scrubs the job row, its step row and the created-event row.
    const store = createSqliteRuntimeJobsStore(dbPath);
    const row = store.getJob("legacy-offline-1");
    expect(row?.status).toBe("queued");
    expect(row?.payload).toMatchObject({ fileId: "file-movie-1", formatId: "format-1080", filename: "Test Movie (2026)" });
    expect(row?.payload).not.toHaveProperty("libraryKeyBase64");
    expect(row?.payload).not.toHaveProperty("token");
    store.close();

    const after = scanForSecrets(dataDir);
    console.info(`[${SUITE}:legacy-scrubbed] hits=${JSON.stringify(after)}`);
    expect(after).toEqual([]);

    // A second boot has nothing left to scrub and the queued job still resumes (it waits for the key push).
    const engine = createEngineV2({ dbPath });
    parkOfflineSteps(engine);
    await engine.start();
    const resumed = await engine.get("legacy-offline-1");
    expect(resumed?.job.payload).not.toHaveProperty("libraryKeyBase64");
    await engine.stop();
    expect(scanForSecrets(dataDir)).toEqual([]);
  });
});
