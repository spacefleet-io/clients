/**
 * @req LIB-LANG-02
 * @test-id LIB-LANG-02-RUNTIME-001
 * @level integration
 *
 * Why: per-language synopses and episode texts are kept in the library as `setting.set` rows
 * (`localized_text_v1:<type>:<id>:<language>`), one per title and language. The renderer reads them one at a time
 * with `getSetting`, so they must stay out of the snapshot's settings map: otherwise every library write ships
 * every title's texts to the renderer. Runs under `bun test` (bun:sqlite) on the REAL LibraryDb.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { localizedTextKey, serializeLocalizedText } from "@space/shared/localizedTexts";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[localized-texts-snapshot]";
let roots: string[] = [];
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // No server: queued ops stay pending (the flush just fails).
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.SF_USER_DATA_PATH;
});

describe("localized texts stay out of the snapshot (LIB-LANG-02)", () => {
  it("@req LIB-LANG-02 a kept text is readable by key and absent from the snapshot settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-localized-texts-"));
    roots.push(root);
    process.env.SF_USER_DATA_PATH = root;
    const db = await LibraryDb.openLocal("token-a", "key");
    db.setSyncEnabled(true);

    console.info(`${TAG} phase=write`);
    const key = localizedTextKey("tv", 100, "fr");
    const value = serializeLocalizedText({
      overview: "Synopsis",
      episodes: [{ seasonNumber: 1, episodeNumber: 1, name: "Le Début", overview: "Tout commence." }],
      absent: [],
      fetchedAt: "2026-11-16T00:00:00.000Z",
    });
    await db.setSetting(key, value);
    await db.setSetting("ui_theme", "dark");

    console.info(`${TAG} phase=read`);
    const stored = db.getSetting(key);
    const settings = db.getSnapshot().settings ?? {};
    console.info(`${TAG} getSetting=${stored?.value?.length ?? 0} chars snapshotKeys=${JSON.stringify(Object.keys(settings))}`);
    expect(stored?.value).toBe(value);
    expect(settings.ui_theme?.value).toBe("dark");
    expect(Object.keys(settings).filter((k) => k.startsWith("localized_text_v1:"))).toEqual([]);
  });
});
