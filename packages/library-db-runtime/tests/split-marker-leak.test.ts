/**
 * @test-id LIB-SPLIT-MARKER-LEAK-001
 * @level unit (real-engine, bun:sqlite)
 * @bugfix @regression-proof
 *
 * Regression guard for the cross-client split-marker leak bug surfaced
 * on 2026-05-19: a snapshot's `app_settings` table can carry the
 * uploader's `migration_phase3_<group>_split = 1` markers. Pre-fix,
 * `splitGroupFromLegacy("core", ...)` copied those markers into the
 * downloading client's fresh coreDb wholesale. Then
 * `initializeMetadataDb` → `splitGroupFromLegacy("metadata", ...)`
 * called `isSplitDone(coreDb, "metadata")`, found the (leaked) marker,
 * and early-returned without copying any metadata-group rows. Same for
 * playback / ingest / templates. Result: per-group files end up empty,
 * pre-split.bak retains all the data, and the user sees the library as
 * "media items but no metadata."
 *
 * Post-fix: the copy step filters out rows whose `key` starts with
 * `migration_phase3_` so cross-client markers cannot influence
 * THIS client's split state. The local markers are then re-set by each
 * group's own `markSplitDone(coreDb, group)` at end-of-split.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";
import { splitGroupFromLegacy } from "../src/librarySplitMigration";
import type { SqliteDatabase } from "../src/db";

const open = (): SqliteDatabase => new Database(":memory:") as unknown as SqliteDatabase;

const tableRowCount = (db: SqliteDatabase, table: string): number => {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n?: number };
    return Number(row?.n ?? 0);
  } catch {
    return -1;
  }
};

const getAppSetting = (db: SqliteDatabase, key: string): string | null => {
  try {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1;")
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
};

// Suite-id: split-marker-leak
// Dumps marker count per group across all relevant DBs, and the row counts
// of the canary tables that should/shouldn't have been copied.
const dumpMarkerLeakSnapshot = (
  label: string,
  ctx: {
    legacy?: SqliteDatabase;
    coreDb?: SqliteDatabase;
    metadataDb?: SqliteDatabase;
    playbackDb?: SqliteDatabase;
  },
) => {
  try {
    console.error(`=== [split-marker-leak:${label}] snapshot ===`);
    const markersFor = (db: SqliteDatabase | undefined, locLabel: string): Record<string, unknown> => {
      const out: Record<string, unknown> = { _location: locLabel };
      if (!db) return out;
      for (const group of ["core", "metadata", "playback", "ingest", "templates"]) {
        out[`migration_phase3_${group}_split`] = getAppSetting(db, `migration_phase3_${group}_split`);
      }
      out["preferredAudioLanguage"] = getAppSetting(db, "preferredAudioLanguage");
      return out;
    };

    console.error(`markers (legacy):\n${JSON.stringify(markersFor(ctx.legacy, "legacy"), null, 2)}`);
    console.error(`markers (coreDb):\n${JSON.stringify(markersFor(ctx.coreDb, "coreDb"), null, 2)}`);
    console.error(`markers (metadataDb):\n${JSON.stringify(markersFor(ctx.metadataDb, "metadataDb"), null, 2)}`);
    console.error(`markers (playbackDb):\n${JSON.stringify(markersFor(ctx.playbackDb, "playbackDb"), null, 2)}`);

    const canaryCounts: Record<string, number | string> = {};
    if (ctx.coreDb) canaryCounts["coreDb.media_items"] = tableRowCount(ctx.coreDb, "media_items");
    if (ctx.metadataDb)
      canaryCounts["metadataDb.media_files"] = tableRowCount(ctx.metadataDb, "media_files");
    if (ctx.playbackDb) {
      canaryCounts["playbackDb.media_audio_tracks"] = tableRowCount(ctx.playbackDb, "media_audio_tracks");
      canaryCounts["playbackDb.media_subtitles"] = tableRowCount(ctx.playbackDb, "media_subtitles");
    }
    console.error(`canary row counts:\n${JSON.stringify(canaryCounts, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const seedLegacyWithLeakedMarkers = (legacy: SqliteDatabase) => {
  ensureLibrarySchema(legacy);

  // 1 media_items row (core).
  legacy
    .prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run("m1", "movie", "Movie One", "t0", "t0", 1, 0);

  // 1 row each in metadata + playback child tables — these are what
  // disappeared in the live bug.
  legacy
    .prepare(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES (?, ?, ?, ?, ?);`
    )
    .run("f1", "m1", "m1.mkv", "t0", "local");

  legacy
    .prepare(
      `INSERT INTO media_audio_tracks (id, media_id, language, label, is_default, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run("aud1", "m1", "en", "English", 1, "embedded", "t0");

  legacy
    .prepare(
      `INSERT INTO media_subtitles (id, media_id, language, label, is_default, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run("sub1", "m1", "en", "English", 1, "embedded", "t0");

  // The leak: simulate a snapshot uploaded by a different client that had
  // already completed Phase 3. Their core.app_settings shipped these markers.
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("migration_phase3_core_split", "1", "t0");
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("migration_phase3_metadata_split", "1", "t0");
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("migration_phase3_playback_split", "1", "t0");
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("migration_phase3_ingest_split", "1", "t0");
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("migration_phase3_templates_split", "1", "t0");

  // Plus a non-marker app_setting to confirm the filter is precisely
  // scoped — legitimate cross-client user preferences MUST still copy.
  legacy
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run("preferredAudioLanguage", "en", "t0");
};

describe("splitGroupFromLegacy — cross-client migration-marker leak (regression)", () => {
  it("does NOT copy migration_phase3_*_split markers into target coreDb", () => {
    console.info(`[split-marker-leak:no-leak] seeding legacy with 5 leaked markers`);
    const legacy = open();
    const coreDb = open();
    seedLegacyWithLeakedMarkers(legacy);

    console.info(`[split-marker-leak:no-leak] running splitGroupFromLegacy(group=core)`);
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: false,
    });

    try {
      // The 5 leaked markers from the snapshot must not be in target.
      // (The local "core" marker IS expected — set by markSplitDone at
      // end-of-split — but it must come from THIS run, not the leak.)
      const observed = {
        metadata: getAppSetting(coreDb, "migration_phase3_metadata_split"),
        playback: getAppSetting(coreDb, "migration_phase3_playback_split"),
        ingest: getAppSetting(coreDb, "migration_phase3_ingest_split"),
        templates: getAppSetting(coreDb, "migration_phase3_templates_split"),
        core: getAppSetting(coreDb, "migration_phase3_core_split"),
      };
      console.info(`[split-marker-leak:no-leak] post-split markers=${JSON.stringify(observed)}`);
      expect(observed.metadata).toBeNull();
      expect(observed.playback).toBeNull();
      expect(observed.ingest).toBeNull();
      expect(observed.templates).toBeNull();
      // The local "core" marker must be present — markSplitDone set it.
      expect(observed.core).toBe("1");
    } catch (err) {
      console.error(`[split-marker-leak:no-leak] assertion failed`);
      dumpMarkerLeakSnapshot("no-leak-failure", { legacy, coreDb });
      throw err;
    }
  });

  it("preserves non-marker app_settings rows (filter is scoped to migration markers only)", () => {
    console.info(`[split-marker-leak:preserve] seeding legacy with leaked markers`);
    const legacy = open();
    const coreDb = open();
    seedLegacyWithLeakedMarkers(legacy);

    console.info(`[split-marker-leak:preserve] running splitGroupFromLegacy(group=core)`);
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: false,
    });

    try {
      const preferred = getAppSetting(coreDb, "preferredAudioLanguage");
      console.info(`[split-marker-leak:preserve] preferredAudioLanguage=${preferred}`);
      // Legitimate user-preference rows must still cross the split.
      expect(preferred).toBe("en");
    } catch (err) {
      console.error(`[split-marker-leak:preserve] assertion failed`);
      dumpMarkerLeakSnapshot("preserve-failure", { legacy, coreDb });
      throw err;
    }
  });

  it("subsequent metadata/playback splits actually run when markers haven't leaked", () => {
    console.info(
      `[split-marker-leak:cascade] seeding legacy, will split core → metadata → playback`,
    );
    const legacy = open();
    const coreDb = open();
    const metadataDb = open();
    const playbackDb = open();
    seedLegacyWithLeakedMarkers(legacy);

    // Phase 1: core split. Pre-fix this copied all 5 leaked markers into
    // coreDb and broke every subsequent group.
    console.info(`[split-marker-leak:cascade] phase 1 — core split`);
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: true,
    });

    try {
      // Phase 2: metadata split. With the leaked marker filtered out,
      // isSplitDone(coreDb, "metadata") returns FALSE and the copy proceeds.
      console.info(`[split-marker-leak:cascade] phase 2 — metadata split`);
      const metadataResult = splitGroupFromLegacy({
        legacyDb: legacy,
        targetDb: metadataDb,
        coreDb,
        group: "metadata",
        dropFromLegacy: true,
      });
      console.info(
        `[split-marker-leak:cascade] metadata result.copied=${metadataResult.copied} media_files count=${tableRowCount(metadataDb, "media_files")}`,
      );
      expect(metadataResult.copied).toBe(true);
      expect(tableRowCount(metadataDb, "media_files")).toBe(1);

      // Phase 3: playback split.
      console.info(`[split-marker-leak:cascade] phase 3 — playback split`);
      const playbackResult = splitGroupFromLegacy({
        legacyDb: legacy,
        targetDb: playbackDb,
        coreDb,
        group: "playback",
        dropFromLegacy: true,
      });
      console.info(
        `[split-marker-leak:cascade] playback result.copied=${playbackResult.copied} audio=${tableRowCount(playbackDb, "media_audio_tracks")} subs=${tableRowCount(playbackDb, "media_subtitles")}`,
      );
      expect(playbackResult.copied).toBe(true);
      expect(tableRowCount(playbackDb, "media_audio_tracks")).toBe(1);
      expect(tableRowCount(playbackDb, "media_subtitles")).toBe(1);
    } catch (err) {
      console.error(`[split-marker-leak:cascade] assertion failed`);
      dumpMarkerLeakSnapshot("cascade-failure", { legacy, coreDb, metadataDb, playbackDb });
      throw err;
    }
  });
});
