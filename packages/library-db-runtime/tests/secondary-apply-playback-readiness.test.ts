/**
 * @test-id LIB-SECONDARY-APPLY-READINESS-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix @regression-proof
 *
 * Regression guard for the playback-dataset-readiness bug fixed by commit
 * f3990d0f — shipped there as a pure deletion with no test, so this fills
 * that gap.
 *
 * `applyLibraryOps`' secondary apply (`applySecondary`) writes the
 * metadata / playback / templates groups, then calls
 * `setDatasetStatus({ playback: true })` — the signal the desktop
 * renderer's play-button gate waits on (30s timeout otherwise).
 *
 * A leftover Phase 3 `UPDATE media_items` ran against the legacy `this.db`
 * handle, which `retireLegacyDb()` closes in the constructor. The throw
 * ("Database not open") was swallowed by `applySecondary`'s outer catch as
 * a "secondary dataset apply failed" warning, and the
 * `setDatasetStatus({ playback: true })` immediately after it never ran —
 * so `datasetStatus.playback` stayed `false` forever and Play timed out.
 *
 * It was masked for months by the manifest-encoding bug (clients couldn't
 * sync ops from remote, so this path rarely ran); the manifest fix
 * unmasked it.
 *
 * This test pins the contract: after a `media.upsert` flows through
 * `applyLibraryOps` and the async secondary apply settles,
 * `datasetStatus.playback` is `true`. Any future reintroduction of a
 * closed-handle `this.db.*` call into `applySecondary` re-throws, the
 * catch swallows it, and this test fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-secondary-readiness-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[secondary-apply-playback-readiness:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[secondary-apply-playback-readiness:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: secondary-apply-playback-readiness
// Dumps the datasetStatus tri-state, the op-stream tail (last 10 ops), and
// the secondary in-flight promise state — three signals together identify
// whether `setDatasetStatus({ playback: true })` ran or got swallowed.
const dumpReadinessSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    inFlight?: Promise<unknown> | null | undefined;
    appliedOpIds?: string[];
  },
) => {
  try {
    console.error(`=== [secondary-apply-playback-readiness:${label}] snapshot ===`);
    if (ctx.appliedOpIds) {
      console.error(`appliedOpIds=${JSON.stringify(ctx.appliedOpIds)}`);
    }
    console.error(`inFlight present=${ctx.inFlight != null}`);

    if (ctx.db) {
      let status: unknown = "(unknown)";
      try {
        status = ctx.db.getDatasetStatus();
      } catch (err) {
        status = `(getDatasetStatus failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`datasetStatus:\n${JSON.stringify(status, null, 2)}`);

      let snapshot: unknown = "(unknown)";
      try {
        const s = ctx.db.getSnapshot();
        snapshot = {
          mediaCount: Array.isArray(s.media) ? s.media.length : "(n/a)",
          mediaDetailsCount: Array.isArray(s.mediaDetails)
            ? s.mediaDetails.length
            : "(n/a)",
        };
      } catch (err) {
        snapshot = `(getSnapshot failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`snapshot summary:\n${JSON.stringify(snapshot, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// A minimal but complete MediaDetails. `hasFiles: false` keeps the op out
// of `shouldSuppressMediaUpsertSecondary` (which only suppresses a
// hasFiles=true op with an empty playback payload), so the secondary apply
// runs all three group transactions and reaches the playback-readiness call.
const mediaDetails = (id: string): MediaDetails => ({
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
});

const mediaUpsertOp = (id: string): LibraryOp => ({
  id: `op-${id}`,
  type: "media.upsert",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { details: mediaDetails(id) },
});

// `applyLibraryOps` is private and `secondaryOpsInFlight` is a private field;
// both exist at runtime. The remote-sync entry point that drives them needs
// a live API + manifest, so the suite reaches the apply path directly — the
// same pattern publish-guards.test.ts uses for LibraryDb internals.
type ApplyHook = {
  applyLibraryOps: (ops: LibraryOp[]) => Promise<void>;
  secondaryOpsInFlight: Promise<unknown> | null;
};

describe("applyLibraryOps secondary apply — playback dataset readiness", () => {
  it("flips datasetStatus.playback to true after a media.upsert", async () => {
    console.info(`[secondary-apply-playback-readiness:single] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const hook = db as unknown as ApplyHook;

    console.info(`[secondary-apply-playback-readiness:single] applying media.upsert(m1)`);
    await hook.applyLibraryOps([mediaUpsertOp("m1")]);

    // applyLibraryOps fires applySecondary asynchronously and parks the
    // promise on secondaryOpsInFlight. A media.upsert always schedules it.
    const inflight = hook.secondaryOpsInFlight;
    console.info(
      `[secondary-apply-playback-readiness:single] inflight present=${inflight != null}, awaiting`,
    );
    try {
      expect(inflight).not.toBeNull();
      await inflight;

      const status = db.getDatasetStatus();
      console.info(
        `[secondary-apply-playback-readiness:single] post-await status=${JSON.stringify(status)}`,
      );
      expect(status.metadata).toBe(true);
      // The assertion the bug failed: the dead this.db UPDATE threw before
      // setDatasetStatus({ playback: true }), leaving this false.
      expect(status.playback).toBe(true);
    } catch (err) {
      console.error(`[secondary-apply-playback-readiness:single] assertion failed`);
      dumpReadinessSnapshot("single-failure", {
        db,
        inFlight: hook.secondaryOpsInFlight,
        appliedOpIds: ["op-m1"],
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("playback readiness holds across repeated media.upsert applies", async () => {
    console.info(`[secondary-apply-playback-readiness:repeat] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const hook = db as unknown as ApplyHook;
    const appliedOpIds: string[] = [];

    try {
      for (const id of ["m1", "m2", "m3"]) {
        console.info(`[secondary-apply-playback-readiness:repeat] applying media.upsert(${id})`);
        await hook.applyLibraryOps([mediaUpsertOp(id)]);
        appliedOpIds.push(`op-${id}`);
        await hook.secondaryOpsInFlight;
        const status = db.getDatasetStatus();
        console.info(
          `[secondary-apply-playback-readiness:repeat] after ${id} status=${JSON.stringify(status)}`,
        );
        expect(status.playback).toBe(true);
      }
    } catch (err) {
      console.error(`[secondary-apply-playback-readiness:repeat] assertion failed`);
      dumpReadinessSnapshot("repeat-failure", {
        db,
        inFlight: hook.secondaryOpsInFlight,
        appliedOpIds,
      });
      throw err;
    } finally {
      db.close();
    }
  });
});
