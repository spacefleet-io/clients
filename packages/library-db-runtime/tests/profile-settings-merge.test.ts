/**
 * @test-id LIB-PROFILE-SETTINGS-MERGE-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix
 *
 * The runtime LibraryDb behind desktop receives the same `[p:<pid>:]profile_settings_v1` ops as phone/TV, so it has
 * to merge them the same way (review of PR 836, Main 2026-10-30): field by field, the newer time per field wins
 * (`mergeProfileSettingsOps`, packages/shared/src/profileSettings.ts). Otherwise one device editing autoplay and
 * another editing quality would lose one of the two edits on desktop. Deleting the main profile moves the new
 * main's settings in with `resetAt`, so the deleted main's own fields are dropped on the other devices.
 *
 * Desktop's own status for ACCT-SQUAD-03 stays as it is; this only guards the shared receive path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PROFILE_SETTINGS_KEY,
  PROFILE_SETTINGS_SEED_AT,
  mergeProfileSettings,
  mergeProfileSettingsOps,
  parseProfileSettings,
  serializeProfileSettings,
} from "@space/shared/profileSettings";
import type { LibraryOp } from "@space/shared/libraryOps";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "profile-settings-merge";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}] phase=${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type QueuedOp = { id: string; type: string; createdAt: string; payload: Record<string, unknown> };
type Internals = { pendingOps: QueuedOp[]; applyLibraryOps(ops: unknown[]): Promise<void> };
const internalsOf = (db: LibraryDb) => db as unknown as Internals; // test-only peek at private sync state

const MAIN = { id: "main-uuid", isMain: true };
const KID = { id: "kid-uuid", isMain: false };
const KID_KEY = `p:${KID.id}:${PROFILE_SETTINGS_KEY}`;

let roots: string[] = [];
let dbs: LibraryDb[] = [];
let originalFetch: typeof globalThis.fetch | null = null;
// Sync is on, so the debounced flush seals the queued ops: it needs a real 32-byte library key.
const LIBRARY_KEY = Buffer.alloc(32, 7).toString("base64");

const openDevice = async (label: string) => {
  const root = mkdtempSync(join(tmpdir(), `sf-profile-settings-${label}-`));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
  const db = await LibraryDb.openLocal(`token-${label}`, LIBRARY_KEY);
  dbs.push(db);
  db.setSyncEnabled(true);
  log("open", { label, root });
  return db;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // No server: queued ops stay in pendingOps (the flush just fails).
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  // Close before the files go: a flush left pending must not run into the next test (it did in CI run 34516).
  for (const db of dbs) db.close();
  dbs = [];
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.SF_USER_DATA_PATH;
});

describe("runtime LibraryDb profile settings merge", () => {
  it("@req ACCT-SQUAD-03 an incoming op that edits another field keeps this device's own field", async () => {
    const db = await openDevice("merge");
    const local = mergeProfileSettings(null, { autoplayNextEpisode: false }, "2026-10-20T00:00:00.000Z");
    db.setSetting(PROFILE_SETTINGS_KEY, serializeProfileSettings(local));
    const remote = mergeProfileSettings(
      mergeProfileSettings(null, { autoplayNextEpisode: true }, "2026-10-01T00:00:00.000Z"),
      { quality: "720p" },
      "2099-01-01T00:00:00.000Z"
    );
    await internalsOf(db).applyLibraryOps([
      {
        id: "op-remote",
        type: "setting.set",
        createdAt: remote.updatedAt,
        payload: { key: PROFILE_SETTINGS_KEY, value: serializeProfileSettings(remote), updatedAt: remote.updatedAt },
      },
    ]);
    const after = parseProfileSettings(db.getSetting(PROFILE_SETTINGS_KEY)?.value);
    log("after-apply", after);
    expect(after).toMatchObject({ autoplayNextEpisode: false, quality: "720p" });
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 promoting a profile to main drops the deleted main's fields on the other devices", async () => {
    const db = await openDevice("promote");
    db.setActiveProfile(MAIN);
    const oldMain = serializeProfileSettings(mergeProfileSettings(null, { quality: "2160p", skipMode: "manual" }, "2026-10-20T00:00:00.000Z"));
    db.setSetting(PROFILE_SETTINGS_KEY, oldMain);
    db.setSetting(KID_KEY, serializeProfileSettings(mergeProfileSettings(null, { quality: "480p" }, "2026-10-21T00:00:00.000Z")));
    await db.promoteProfileToMain(KID.id);
    const op = internalsOf(db)
      .pendingOps.filter((queued) => queued.type === "setting.set" && queued.payload.key === PROFILE_SETTINGS_KEY)
      .at(-1);
    log("promotion-op", op?.payload);
    expect(op, "the promotion queues the new main's settings").toBeDefined();
    const queuedOp: LibraryOp = op as LibraryOp; // pendingOps holds LibraryOps; the Internals peek types them loosely
    const [folded] = mergeProfileSettingsOps(
      [queuedOp],
      new Map([[PROFILE_SETTINGS_KEY, { value: oldMain, updatedAt: "2026-10-20T00:00:00.000Z" }]])
    );
    const there = folded?.type === "setting.set" ? parseProfileSettings(folded.payload.value) : null;
    log("other-device", there);
    expect(there?.quality).toBe("480p");
    expect(there?.skipMode, "the deleted main's own field is gone everywhere").toBeUndefined();
  });

  it("@req ACCT-SQUAD-03 @bugfix @regression-proof a seed stamped the epoch loses to the profile's real record arriving later, even an old one", async () => {
    const db = await openDevice("seed");
    const seed = mergeProfileSettings(null, { quality: "720p", audioLanguage: "fr" }, PROFILE_SETTINGS_SEED_AT);
    db.setSetting(KID_KEY, serializeProfileSettings(seed), PROFILE_SETTINGS_SEED_AT);
    const row = db.getSetting(KID_KEY);
    const queued = internalsOf(db).pendingOps.filter((op) => op.type === "setting.set" && op.payload.key === KID_KEY).at(-1);
    log("seed", { row: row?.updatedAt, op: queued?.payload.updatedAt });
    expect(row?.updatedAt).toBe(PROFILE_SETTINGS_SEED_AT);
    expect(queued?.payload.updatedAt, "other devices see the seed's epoch time too").toBe(PROFILE_SETTINGS_SEED_AT);

    const lastWeek = "2026-10-23T10:00:00.000Z";
    const real = mergeProfileSettings(null, { quality: "1080p", audioLanguage: "en" }, lastWeek);
    await internalsOf(db).applyLibraryOps([
      {
        id: "op-real",
        type: "setting.set",
        createdAt: lastWeek,
        payload: { key: KID_KEY, value: serializeProfileSettings(real), updatedAt: lastWeek },
      },
    ]);
    const after = parseProfileSettings(db.getSetting(KID_KEY)?.value);
    log("after-real", after);
    expect(after).toMatchObject({ quality: "1080p", audioLanguage: "en" });
  });
});
