/**
 * @req PLAY-TRACK-04
 *
 * Audio + subtitle choices are remembered per movie / per TV show and sync
 * between devices like the resume position: one `setting.set` record
 * `track_prefs_v1:<mediaId>`. Runs under `bun test` (bun:sqlite).
 *
 * Covered on the REAL LibraryDb:
 *  - set/get round trip, read-modify-write per field (audio change keeps the subtitle choice)
 *  - the queued op carries the same `updatedAt` as the stored value (receivers do last-write-wins on it)
 *  - a second LibraryDb ("other device") applying that op reads the same prefs
 *  - the legacy `setPreferredAudioLanguage` now routes through the synced record
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[track-prefs]";
type Internals = {
  pendingOps: Array<{ id: string; type: string; createdAt: string; payload: { key: string; value: string; updatedAt: string } }>;
  applyLibraryOps(ops: unknown[]): Promise<void>;
};
const internalsOf = (db: LibraryDb) => db as unknown as Internals; // test-only peek at private sync state

let roots: string[] = [];
let originalFetch: typeof globalThis.fetch | null = null;

const openDevice = async (label: string) => {
  const root = mkdtempSync(join(tmpdir(), `sf-track-prefs-${label}-`));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
  const db = await LibraryDb.openLocal(`token-${label}`, "key");
  db.setSyncEnabled(true);
  return db;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // No server: queued ops must stay in pendingOps (the flush just fails).
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.SF_USER_DATA_PATH;
});

describe("synced track prefs (PLAY-TRACK-04)", () => {
  it("@req PLAY-TRACK-04 remembers audio and subtitle per media, each field independently", async () => {
    const db = await openDevice("a");
    expect(db.getTrackPrefs("show-1")).toBeNull();

    await db.setTrackPrefs("show-1", { audioLanguage: "eng" });
    await db.setTrackPrefs("show-1", { subtitle: { language: "fre", format: "srt" } });
    const prefs = db.getTrackPrefs("show-1");
    console.info(`${TAG} after audio then subtitle: ${JSON.stringify(prefs)}`);
    expect(prefs?.audioLanguage).toBe("en");
    expect(prefs?.subtitle).toEqual({ language: "fr", format: "srt" });

    await db.setTrackPrefs("show-1", { subtitle: "off" });
    expect(db.getTrackPrefs("show-1")).toMatchObject({ audioLanguage: "en", subtitle: "off" });
    // Another title is untouched.
    expect(db.getTrackPrefs("movie-9")).toBeNull();
    db.close();
  });

  it("@req PLAY-TRACK-04 uploads one setting.set op whose updatedAt equals the stored value's", async () => {
    const db = await openDevice("a");
    await db.setTrackPrefs("movie-1", { audioLanguage: "ja" });
    const ops = internalsOf(db).pendingOps.filter((op) => op.type === "setting.set" && op.payload.key === "track_prefs_v1:movie-1");
    console.info(`${TAG} queued ops: ${JSON.stringify(ops)}`);
    expect(ops).toHaveLength(1);
    const stored = JSON.parse(ops[0]!.payload.value) as { audioLanguage: string; subtitle: unknown; updatedAt: string };
    expect(stored.audioLanguage).toBe("ja");
    expect(stored.subtitle).toBeNull();
    expect(ops[0]!.payload.updatedAt).toBe(stored.updatedAt);
    db.close();
  });

  it("@req PLAY-TRACK-04 a second device applying the op reads the same prefs", async () => {
    // One LibraryDb per process (module-level state): device A closes before B opens;
    // the ops travel as plain JSON, exactly like the server's op log.
    const deviceA = await openDevice("a");
    await deviceA.setTrackPrefs("show-1", { audioLanguage: "fr" });
    await deviceA.setTrackPrefs("show-1", { subtitle: { language: "en", forced: true } });
    const ops = structuredClone(internalsOf(deviceA).pendingOps.filter((op) => op.payload.key === "track_prefs_v1:show-1"));
    expect(ops.length).toBeGreaterThan(0);
    const expected = deviceA.getTrackPrefs("show-1");
    deviceA.close();

    const deviceB = await openDevice("b");
    expect(deviceB.getTrackPrefs("show-1")).toBeNull();
    await internalsOf(deviceB).applyLibraryOps(ops);
    console.info(`${TAG} device B after sync: ${JSON.stringify(deviceB.getTrackPrefs("show-1"))}`);
    expect(deviceB.getTrackPrefs("show-1")).toEqual(expected);

    // Device B changes only audio: keeps A's subtitle choice; applying it on A converges.
    await deviceB.setTrackPrefs("show-1", { audioLanguage: "en" });
    const back = structuredClone(internalsOf(deviceB).pendingOps.filter((op) => op.payload.key === "track_prefs_v1:show-1"));
    deviceB.close();

    process.env.SF_USER_DATA_PATH = roots[0];
    const reopenedA = await LibraryDb.openLocal("token-a", "key");
    await internalsOf(reopenedA).applyLibraryOps(back);
    expect(reopenedA.getTrackPrefs("show-1")).toMatchObject({ audioLanguage: "en", subtitle: { language: "en", forced: true } });
    reopenedA.close();
  });

  it("@req PLAY-TRACK-04 setPreferredAudioLanguage routes through the synced record", async () => {
    const db = await openDevice("a");
    await db.setTrackPrefs("movie-1", { subtitle: "off" });
    await db.setPreferredAudioLanguage("movie-1", "fre");
    expect(db.getTrackPrefs("movie-1")).toMatchObject({ audioLanguage: "fr", subtitle: "off" });
    expect(internalsOf(db).pendingOps.some((op) => op.payload.key === "track_prefs_v1:movie-1")).toBe(true);
    await db.setPreferredAudioLanguage("movie-1", null);
    expect(db.getTrackPrefs("movie-1")?.audioLanguage).toBeNull();
    db.close();
  });

  it("@req PLAY-TRACK-04 ignores a malformed stored value", async () => {
    const db = await openDevice("a");
    await db.setSetting("track_prefs_v1:movie-1", "{not json");
    expect(db.getTrackPrefs("movie-1")).toBeNull();
    await db.setTrackPrefs("movie-1", { audioLanguage: "de" });
    expect(db.getTrackPrefs("movie-1")?.audioLanguage).toBe("de");
    db.close();
  });
});
