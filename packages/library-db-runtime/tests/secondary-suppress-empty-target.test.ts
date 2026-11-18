/**
 * @test-id LIB-SECONDARY-SUPPRESS-EMPTY-TARGET-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix @regression-proof
 *
 * Regression guard for the silent metadata loss bug surfaced on
 * 2026-05-18: every secondary write (metadata + playback + templates)
 * was suppressed when an incoming media.upsert carried hasFiles=true
 * with empty playback children. `cache.json` version advanced because
 * no error was thrown; per-group tables stayed at 0 rows.
 *
 * Pre-fix: `shouldSuppressMediaUpsertSecondary(details)` returned
 * `incomingPlaybackEmpty && details.hasFiles` unconditionally. An empty
 * per-group DB receiving such an op had no data to lose, but the guard
 * still skipped the write — blocking initial population from a fresh
 * snapshot or op-log replay against a wiped local cache.
 *
 * Post-fix: the guard takes a snapshot of mediaIds with existing
 * secondary data and only suppresses when this op would actually
 * clobber existing rows (delete-then-empty-insert). Empty target =
 * no-op = allow.
 *
 * The op builder's unconditional `DELETE FROM media_audio_tracks
 * WHERE media_id = ?` (see appendMediaMetadata / appendMediaPlayback
 * in library-db-definition/ops.ts:286, 337-343) is what makes the
 * suppression matter when data DOES exist — that branch is covered
 * by the "preserves existing rows" test below.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-secondary-suppress-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[secondary-suppress-empty-target:setup] root=${root}`);
});

afterEach(() => {
  console.info(
    `[secondary-suppress-empty-target:teardown] root-exists=${existsSync(root)} root=${root}`,
  );
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: secondary-suppress-empty-target
// The guard pivots on three inputs: (incoming children empty?), (target has
// existing rows for this mediaId?), and (hasFiles?). Dump them flat so any
// mismatch between observed vs expected guard output is one-glance.
const dumpSuppressSnapshot = (
  label: string,
  ctx: {
    details?: MediaDetails;
    existingMediaIds?: ReadonlySet<string>;
    actualSuppression?: boolean;
    expectedSuppression?: boolean;
    extraNotes?: Record<string, unknown>;
    capturedError?: unknown;
  },
) => {
  try {
    console.error(`=== [secondary-suppress-empty-target:${label}] snapshot ===`);
    if (ctx.details) {
      const d = ctx.details;
      console.error(
        `op-details: id=${d.id} hasFiles=${d.hasFiles} files.len=${d.files?.length ?? 0} ` +
          `formats.len=${d.formats?.length ?? 0} audioTracks.len=${d.audioTracks?.length ?? 0} ` +
          `subtitles.len=${d.subtitles?.length ?? 0} chapters.len=${d.chapters?.length ?? 0}`,
      );
      const incomingPlaybackEmpty =
        (d.files?.length ?? 0) === 0 &&
        (d.formats?.length ?? 0) === 0 &&
        (d.audioTracks?.length ?? 0) === 0 &&
        (d.subtitles?.length ?? 0) === 0 &&
        (d.chapters?.length ?? 0) === 0;
      console.error(`derived: incomingPlaybackEmpty=${incomingPlaybackEmpty}`);
    }
    if (ctx.existingMediaIds) {
      console.error(`existingMediaIds=${JSON.stringify([...ctx.existingMediaIds])}`);
    }
    if (ctx.actualSuppression !== undefined) {
      console.error(`actual suppression=${ctx.actualSuppression}`);
    }
    if (ctx.expectedSuppression !== undefined) {
      console.error(`expected suppression=${ctx.expectedSuppression}`);
    }
    if (ctx.extraNotes) {
      console.error(`extraNotes=${JSON.stringify(ctx.extraNotes, null, 2)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const baseDetails = (id: string, overrides: Partial<MediaDetails> = {}): MediaDetails => ({
  id,
  type: "movie",
  catalogId: null,
  title: `Movie ${id}`,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  hasFiles: false,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  files: [],
  formats: [],
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: false,
  ...overrides,
});

const fullDetails = (id: string): MediaDetails => {
  const fileId = `${id}-file-1`;
  const formatId = `${id}-fmt-1`;
  const trackId = `${id}-aud-1`;
  const subId = `${id}-sub-1`;
  return baseDetails(id, {
    hasFiles: true,
    files: [
      {
        id: fileId,
        filename: `${id}.mkv`,
        season: null,
        episode: null,
        desiredFormats: [],
      } as MediaDetails["files"][number],
    ],
    formats: [
      {
        id: formatId,
        mediaId: id,
        fileId,
        quality: "1080p",
        codec: "h264",
        codecString: null,
        bitrateKbps: 5000,
        initKey: null,
        initSize: null,
        durationSeconds: 3600,
        totalSize: 1_000_000,
        sizeMb: 1,
        chunks: [],
        isSource: true,
      } as MediaDetails["formats"][number],
    ],
    audioTracks: [
      {
        id: trackId,
        mediaId: id,
        fileId,
        episodeId: null,
        language: "en",
        label: "English",
        isDefault: true,
        source: "embedded",
        codec: "aac",
        codecString: null,
        initKey: null,
        initSize: null,
        durationSeconds: 3600,
        totalSize: 100_000,
        chunks: [],
      } as MediaDetails["audioTracks"][number],
    ],
    subtitles: [
      {
        id: subId,
        fileId,
        episodeId: null,
        language: "en",
        label: "English",
        objectKey: null,
        format: "srt",
        isDefault: true,
        source: "embedded",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as MediaDetails["subtitles"][number],
    ],
    chapters: [],
  });
};

const upsertOp = (id: string, details: MediaDetails): LibraryOp => ({
  id: `op-${id}-${Date.now()}-${Math.random()}`,
  type: "media.upsert",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { details },
});

// Mirrors the hook pattern used by secondary-apply-playback-readiness.test.ts
// — reach the private apply path + private guard directly so the test
// targets the contract without depending on a running API.
type Hook = {
  applyLibraryOps: (ops: LibraryOp[]) => Promise<void>;
  secondaryOpsInFlight: Promise<unknown> | null;
  shouldSuppressMediaUpsertSecondary: (
    details: MediaDetails,
    existingMediaIds: ReadonlySet<string>
  ) => boolean;
  collectMediaIdsWithSecondaryData: () => ReadonlySet<string>;
};

describe("shouldSuppressMediaUpsertSecondary — only suppress when target has data to lose", () => {
  it("does NOT suppress when target has no existing rows for this mediaId (initial population)", async () => {
    console.info(`[secondary-suppress-empty-target:initial-pop] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    const hook = db as unknown as Hook;

    const empty = new Set<string>();
    const details = baseDetails("M1", { hasFiles: true });

    // Pre-fix: this returned true unconditionally → blocked initial population.
    const actual = hook.shouldSuppressMediaUpsertSecondary(details, empty);
    console.info(`[secondary-suppress-empty-target:initial-pop] actual=${actual} expected=false`);
    try {
      expect(actual).toBe(false);
    } catch (err) {
      dumpSuppressSnapshot("initial-pop-failure", {
        details,
        existingMediaIds: empty,
        actualSuppression: actual,
        expectedSuppression: false,
        capturedError: err,
      });
      throw err;
    }

    db.close();
  });

  it("suppresses when target has existing rows for this mediaId (protect existing data)", async () => {
    console.info(`[secondary-suppress-empty-target:protect-existing] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    const hook = db as unknown as Hook;

    const populated = new Set<string>(["M1"]);
    const details = baseDetails("M1", { hasFiles: true });

    const actual = hook.shouldSuppressMediaUpsertSecondary(details, populated);
    console.info(
      `[secondary-suppress-empty-target:protect-existing] actual=${actual} expected=true`,
    );
    try {
      expect(actual).toBe(true);
    } catch (err) {
      dumpSuppressSnapshot("protect-existing-failure", {
        details,
        existingMediaIds: populated,
        actualSuppression: actual,
        expectedSuppression: true,
        capturedError: err,
      });
      throw err;
    }

    db.close();
  });

  it("does NOT suppress for a DIFFERENT mediaId when target has data for unrelated mediaIds", async () => {
    console.info(`[secondary-suppress-empty-target:different-mediaId] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    const hook = db as unknown as Hook;

    const populated = new Set<string>(["M1"]);
    // Op is for M2 — totally separate media. M2 has no existing rows.
    const details = baseDetails("M2", { hasFiles: true });

    const actual = hook.shouldSuppressMediaUpsertSecondary(details, populated);
    console.info(
      `[secondary-suppress-empty-target:different-mediaId] actual=${actual} expected=false`,
    );
    try {
      expect(actual).toBe(false);
    } catch (err) {
      dumpSuppressSnapshot("different-mediaId-failure", {
        details,
        existingMediaIds: populated,
        actualSuppression: actual,
        expectedSuppression: false,
        capturedError: err,
      });
      throw err;
    }

    db.close();
  });

  it("does NOT suppress when incoming children are non-empty (no risk of empty-clobber)", async () => {
    console.info(`[secondary-suppress-empty-target:non-empty-children] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    const hook = db as unknown as Hook;

    const populated = new Set<string>(["M1"]);
    const details = fullDetails("M1");

    const actual = hook.shouldSuppressMediaUpsertSecondary(details, populated);
    console.info(
      `[secondary-suppress-empty-target:non-empty-children] actual=${actual} expected=false`,
    );
    try {
      expect(actual).toBe(false);
    } catch (err) {
      dumpSuppressSnapshot("non-empty-children-failure", {
        details,
        existingMediaIds: populated,
        actualSuppression: actual,
        expectedSuppression: false,
        capturedError: err,
      });
      throw err;
    }

    db.close();
  });

  it("does NOT suppress when hasFiles=false (the guard only protects file-bearing media)", async () => {
    console.info(`[secondary-suppress-empty-target:no-files] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    const hook = db as unknown as Hook;

    const populated = new Set<string>(["M1"]);
    const details = baseDetails("M1", { hasFiles: false });

    const actual = hook.shouldSuppressMediaUpsertSecondary(details, populated);
    console.info(`[secondary-suppress-empty-target:no-files] actual=${actual} expected=false`);
    try {
      expect(actual).toBe(false);
    } catch (err) {
      dumpSuppressSnapshot("no-files-failure", {
        details,
        existingMediaIds: populated,
        actualSuppression: actual,
        expectedSuppression: false,
        capturedError: err,
      });
      throw err;
    }

    db.close();
  });
});

describe("applyLibraryOps — initial population from a wiped local cache", () => {
  it("populates secondary tables for a media with full children when target is empty", async () => {
    console.info(`[secondary-suppress-empty-target:populate-from-empty] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const hook = db as unknown as Hook;

    console.info(`[secondary-suppress-empty-target:populate-from-empty] applying M1 full-details op`);
    await hook.applyLibraryOps([upsertOp("M1", fullDetails("M1"))]);
    await hook.secondaryOpsInFlight;

    // After applySecondary settles, the mediaId must show up in the
    // existing-data snapshot — proving the writes actually landed.
    const present = hook.collectMediaIdsWithSecondaryData();
    const status = db.getDatasetStatus();
    console.info(
      `[secondary-suppress-empty-target:populate-from-empty] present=${JSON.stringify([...present])} ` +
        `status.metadata=${status.metadata} status.playback=${status.playback}`,
    );
    try {
      expect(present.has("M1")).toBe(true);
      expect(status.metadata).toBe(true);
      expect(status.playback).toBe(true);
    } catch (err) {
      dumpSuppressSnapshot("populate-from-empty-failure", {
        details: fullDetails("M1"),
        existingMediaIds: present,
        capturedError: err,
        extraNotes: { datasetStatus: status },
      });
      throw err;
    }

    db.close();
  });

  it("preserves existing rows when a subsequent op carries empty children for the same mediaId", async () => {
    console.info(`[secondary-suppress-empty-target:preserve-on-empty-op] LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const hook = db as unknown as Hook;

    // 1. Populate M1 with full secondary data.
    console.info(`[secondary-suppress-empty-target:preserve-on-empty-op] step1: populate M1 (full)`);
    await hook.applyLibraryOps([upsertOp("M1", fullDetails("M1"))]);
    await hook.secondaryOpsInFlight;
    const presentAfterFull = hook.collectMediaIdsWithSecondaryData();
    console.info(
      `[secondary-suppress-empty-target:preserve-on-empty-op] post-step1 mediaIds=${JSON.stringify([...presentAfterFull])}`,
    );
    try {
      expect(presentAfterFull.has("M1")).toBe(true);
    } catch (err) {
      dumpSuppressSnapshot("preserve-step1-failure", {
        details: fullDetails("M1"),
        existingMediaIds: presentAfterFull,
        capturedError: err,
      });
      throw err;
    }

    // 2. Apply a follow-up op for the same M1 with hasFiles=true but
    //    EMPTY children. Pre-fix: this would have proceeded into the
    //    secondary write and DELETE-without-INSERT, wiping M1's rows.
    //    Post-fix: the guard sees existing data for M1 → suppress.
    console.info(
      `[secondary-suppress-empty-target:preserve-on-empty-op] step2: applying M1 empty-children op`,
    );
    await hook.applyLibraryOps([
      upsertOp("M1", baseDetails("M1", { hasFiles: true })),
    ]);
    await hook.secondaryOpsInFlight;
    const presentAfterEmpty = hook.collectMediaIdsWithSecondaryData();
    console.info(
      `[secondary-suppress-empty-target:preserve-on-empty-op] post-step2 mediaIds=${JSON.stringify([...presentAfterEmpty])}`,
    );

    // M1's secondary rows must STILL be present after the empty-children op.
    try {
      expect(presentAfterEmpty.has("M1")).toBe(true);
    } catch (err) {
      dumpSuppressSnapshot("preserve-step2-failure", {
        details: baseDetails("M1", { hasFiles: true }),
        existingMediaIds: presentAfterEmpty,
        capturedError: err,
        extraNotes: { presentAfterFull: [...presentAfterFull] },
      });
      throw err;
    }

    db.close();
  });
});
