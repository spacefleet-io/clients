/**
 * @test-id LIB-LANG-02-MOBILE-002
 * @level unit
 * @req LIB-LANG-02[badger-mobile,badger-tv]
 *
 * Why: the phone sheet and the TV page asked the metadata service for a title's details every time a detail page
 * opened in a new app session (synopsis and episode names in the interface language), on every device. The answer is
 * now kept in the library: a page whose row is there asks nothing, a missing row is asked once and written back, and
 * the runtime wires its detail-page sources through this glue and registers the open library.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localizedTextKey, serializeLocalizedText } from "@space/shared/localizedTexts";
import { createKeptTexts, setMobileTextsLibrary } from "../src/lib/metadata/keptTexts";

const TAG = "[kept-texts]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakeLibrary = (rows: Map<string, string>) => ({
  readSetting: vi.fn(async (key: string) => rows.get(key) ?? null),
  writeSetting: vi.fn(async (key: string, value: string) => {
    rows.set(key, value);
  }),
});

describe("phone and TV detail texts come from the library (LIB-LANG-02)", () => {
  it("@req LIB-LANG-02 a kept row answers the synopsis and the episodes with no lookup", async () => {
    const rows = new Map([
      [
        localizedTextKey("tv", 100, "fr"),
        serializeLocalizedText({
          overview: "Synopsis gardé",
          episodes: [{ seasonNumber: 1, episodeNumber: 1, name: "Le Début", overview: "Tout commence." }],
          absent: [],
          fetchedAt: "2026-11-16T00:00:00.000Z",
        }),
      ],
    ]);
    const details = vi.fn(async () => ({ item: { overview: "from the service" } }));
    const kept = createKeptTexts({ details });
    setMobileTextsLibrary(fakeLibrary(rows));

    log("phase=browse");
    const overview = await kept.fetchOverview("tv", 100, "fr");
    const episodes = await kept.fetchEpisodes(100, "fr", ["1:1"]);
    log("phase=read", { overview, episodes, lookups: details.mock.calls.length });
    expect(overview).toBe("Synopsis gardé");
    expect(episodes.map((episode) => episode.name)).toEqual(["Le Début"]);
    expect(details).not.toHaveBeenCalled();
  });

  it("@req LIB-LANG-02 a missing row is asked once and written back", async () => {
    const rows = new Map<string, string>();
    const library = fakeLibrary(rows);
    const details = vi.fn(async () => ({ item: { overview: "Nouveau", episodes: [] } }));
    const kept = createKeptTexts({ details });
    setMobileTextsLibrary(library);

    log("phase=first-open");
    expect(await kept.fetchOverview("movie", 7, "fr")).toBe("Nouveau");
    log("phase=written", { keys: [...rows.keys()] });
    expect(details).toHaveBeenCalledTimes(1);
    expect(rows.has(localizedTextKey("movie", 7, "fr"))).toBe(true);

    log("phase=new-session");
    const nextSession = createKeptTexts({ details });
    expect(await nextSession.fetchOverview("movie", 7, "fr")).toBe("Nouveau");
    expect(details, "the next app session reads the row").toHaveBeenCalledTimes(1);
  });

  it("@req LIB-LANG-02 the runtime uses the kept texts and the library store registers itself", () => {
    const runtime = readFileSync(join(__dirname, "../src/lib/metadata/runtime.ts"), "utf8");
    const store = readFileSync(join(__dirname, "../src/store/library.tsx"), "utf8");
    const direct = runtime.match(/details(Overview|Episodes)\(metadataClient\)/g) ?? [];
    log("phase=source", { direct, registers: /setMobileTextsLibrary\(db\)/.test(store) });
    expect(direct, "no detail-page source asks the service directly").toEqual([]);
    expect(runtime).toMatch(/createKeptTexts\(/);
    expect(store).toMatch(/setMobileTextsLibrary\(db\)/);
    expect(store).toMatch(/setMobileTextsLibrary\(null\)/);
  });
});
