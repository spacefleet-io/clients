import { describe, expect, it } from "vitest";

import {
  buildDashboardActiveJobsByMediaId,
  filterDashboardItems,
  pageLibraryContent,
  selectDashboardImportingMedia,
  selectDashboardProcessingMedia,
  selectDashboardVisibleMedia,
  reuseSameIdSet,
  reuseUnchangedActiveJobStates,
  sortDashboardItems,
} from "../src/renderer/src/lib/dashboardState";

// On assertion failure, dump the inputs + computed selector output so the
// disagreement is diagnosable offline. Wrapped in try/catch so a dump failure
// can't mask the original assertion.
const dumpDashboardSnapshot = (
  label: string,
  ctx: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [dashboard-state:${label}] snapshot ===`);
    console.error(`inputs/outputs:\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const verdict = (label: string, input: Parameters<typeof pageLibraryContent>[0]) => {
  const result = pageLibraryContent(input);
  console.info(`[dashboard-state:${label}] input=${JSON.stringify(input)} verdict=${result}`);
  return result;
};

// @req UX-HOME-03[badger-desktop]
describe("pageLibraryContent: importing titles", () => {
  it("[UX-HOME-03] shows the normal Home (no empty library) when nothing is playable but an import is active", () => {
    // Dashboard counts playable + importing titles as listed.
    const input = { loading: false, listed: true, itemCount: 0 + 1 };
    const result = verdict("importing", input);
    try {
      expect(result).toBe("ready");
    } catch (err) {
      dumpDashboardSnapshot("importing-fail", { input, result });
      throw err;
    }
  });
});

// @req UX-WAIT-04
describe("pageLibraryContent: empty library only once known empty", () => {
  it("[@bugfix][@regression-proof] is loading while the provider is still loading", () => {
    expect(verdict("provider-loading", { loading: true, listed: true, itemCount: 0 })).toBe("loading");
  });

  it("[@bugfix][@regression-proof] is loading while the listed copy has not caught up with the loaded list", () => {
    expect(verdict("deferred-lagging", { loading: false, listed: false, itemCount: 0 })).toBe("loading");
  });

  it("is empty once the load settled and listed nothing", () => {
    expect(verdict("settled-empty", { loading: false, listed: true, itemCount: 0 })).toBe("empty");
  });

  it("is ready as soon as titles are listed, even mid-refresh", () => {
    expect(verdict("refreshing-with-titles", { loading: true, listed: false, itemCount: 3 })).toBe("ready");
  });
});

// @req UX-HOME-03[badger-desktop]
describe("selectDashboardImportingMedia", () => {
  it("[UX-HOME-03] returns only active titles that have no playable file yet", () => {
    const media = [
      { id: "orchard", title: "Orchard", hasFiles: false },
      { id: "ghost", title: "Ghost in the Shell", hasFiles: true },
      { id: "idle", title: "Idle", hasFiles: false },
    ];
    const activeMediaIds = new Set(["orchard", "ghost"]);
    console.info(
      `[UX-HOME-03:importing-media] media=${media.length} activeMediaIds=${JSON.stringify([...activeMediaIds])}`,
    );
    const result = selectDashboardImportingMedia(media, activeMediaIds);
    try {
      expect(result.map((item) => item.id)).toEqual(["orchard"]);
    } catch (err) {
      dumpDashboardSnapshot("importing-media-fail", { media, activeMediaIds: [...activeMediaIds], result });
      throw err;
    }
  });
});

describe("selectDashboardProcessingMedia", () => {
  it("[@bugfix][@regression-proof] keeps active processing media visible even when other dashboard sections hide it", () => {
    const media = [
      { id: "ghost", title: "Ghost in the Shell", hasFiles: true },
      { id: "orchard", title: "Orchard", hasFiles: true },
    ];
    const activeMediaIds = new Set(["ghost"]);
    console.info(
      `[dashboard-state:processing-visible] media=${media.length} activeMediaIds=${JSON.stringify([...activeMediaIds])}`,
    );
    const result = selectDashboardProcessingMedia(media, activeMediaIds);
    try {
      expect(result).toEqual([media[0]]);
    } catch (err) {
      dumpDashboardSnapshot("processing-visible-fail", {
        media,
        activeMediaIds: [...activeMediaIds],
        result,
        expected: [media[0]],
      });
      throw err;
    }
  });
});

describe("selectDashboardVisibleMedia", () => {
  it("[@bugfix][@regression-proof] keeps hasFiles=true media visible when a format job is still active (V2: includeSource is never set)", () => {
    // Repro of the user-reported bug: V2 source-job committed → mediaItems.hasFiles=true,
    // but a 360p format job is still running. Under V1 the source job in completedJobs
    // had includeSource=true, so completedSourceMediaIds caught it. Under V2 the adapter
    // never sets includeSource, so completedSourceMediaIds is empty, and the legacy
    // filter ("hide if active unless source completed") would drop Orchard from the dashboard.
    const media = [
      { id: "orchard", title: "Orchard", hasFiles: true },
      { id: "ghost", title: "Ghost in the Shell", hasFiles: false },
    ];
    const activeMediaIds = new Set(["orchard", "ghost"]); // both have an active format/source job
    const completedSourceMediaIds = new Set<string>(); // empty — V2 adapter never flags includeSource

    console.info(
      `[dashboard-state:visible-v2] media=${JSON.stringify(media.map((m) => ({ id: m.id, hasFiles: m.hasFiles })))} activeMediaIds=${JSON.stringify([...activeMediaIds])} completedSourceMediaIds=${JSON.stringify([...completedSourceMediaIds])}`,
    );
    const visible = selectDashboardVisibleMedia(media, activeMediaIds, completedSourceMediaIds);

    // Orchard must show on the dashboard because hasFiles=true (watchable now), even
    // though a format job is still active. Ghost must remain hidden (still uploading).
    try {
      expect(visible.map((m) => m.id)).toEqual(["orchard"]);
    } catch (err) {
      dumpDashboardSnapshot("visible-v2-fail", {
        media,
        activeMediaIds: [...activeMediaIds],
        completedSourceMediaIds: [...completedSourceMediaIds],
        visibleIds: visible.map((m) => m.id),
        expectedIds: ["orchard"],
      });
      throw err;
    }
  });

  it("includes media without active jobs", () => {
    const media = [{ id: "a", title: "A", hasFiles: true }];
    expect(
      selectDashboardVisibleMedia(media, new Set(), new Set()).map((m) => m.id)
    ).toEqual(["a"]);
  });

  it("falls back to completedSourceMediaIds for media without hasFiles (V1 path)", () => {
    const media = [{ id: "a", title: "A", hasFiles: false }];
    expect(
      selectDashboardVisibleMedia(media, new Set(["a"]), new Set(["a"])).map((m) => m.id)
    ).toEqual(["a"]);
    expect(
      selectDashboardVisibleMedia(media, new Set(["a"]), new Set()).map((m) => m.id)
    ).toEqual([]);
  });
});

describe("buildDashboardActiveJobsByMediaId", () => {
  it("aggregates active dashboard jobs per media id", () => {
    const grouped = buildDashboardActiveJobsByMediaId([
      {
        matchedMediaId: "media-1",
        progress: 20,
        status: "uploading",
        uploadSpeedMbps: 3,
        includeFallback: false,
        includeSource: true,
      },
      {
        matchedMediaId: "media-1",
        progress: 80,
        status: "transcoding",
        includeFallback: true,
        includeSource: false,
        includeAudio: false,
        includeSubtitles: false,
        includeChapters: false,
      },
    ] as any);

    console.info(
      `[dashboard-state:aggregate] grouped keys=${JSON.stringify([...grouped.keys()])} media-1=${JSON.stringify(grouped.get("media-1"))}`,
    );
    try {
      expect(grouped.get("media-1")).toMatchObject({
        total: 2,
        progressSum: 100,
        hasBlocking: true,
        hasFallbackOnly: true,
        hasUploading: true,
        uploadSpeedSum: 3,
        uploadSpeedCount: 1,
      });
    } catch (err) {
      dumpDashboardSnapshot("aggregate-fail", {
        groupedKeys: [...grouped.keys()],
        media1: grouped.get("media-1"),
      });
      throw err;
    }
  });
});

describe("dashboard list helpers", () => {
  it("filters dashboard items by title query", () => {
    const filtered = filterDashboardItems(
      [
        { id: "a", title: "Arrival", addedAt: "2026-03-25T10:00:00.000Z" },
        { id: "b", title: "Orchard", addedAt: "2026-03-25T09:00:00.000Z" },
      ] as any,
      "arr"
    );
    expect(filtered.map((item) => item.id)).toEqual(["a"]);
  });

  it("sorts dashboard items by recent add time descending", () => {
    const sorted = sortDashboardItems(
      [
        { id: "a", title: "A", addedAt: "2026-03-25T09:00:00.000Z", year: 2010 },
        { id: "b", title: "B", addedAt: "2026-03-25T10:00:00.000Z", year: 2020 },
      ] as any,
      "added",
      "desc"
    );
    expect(sorted.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

// @bugfix #2461 @regression-proof: Home re-rendered every poster card on each runtime job progress tick during an
// ingest (renderer frame p95 50 ms against the 33 ms budget of e2e/perf-during-ingest.e2e.test.ts) because the id
// Sets and per-title import states derived from the jobs list were new objects on every tick.
describe("[@bugfix #2461][@regression-proof] job-derived Home state keeps its identity across progress ticks", () => {
  const job = (mediaId: string, progress: number) => ({
    matchedMediaId: mediaId,
    progress,
    status: "processing",
    includeFallback: false,
    includeSource: true,
  });

  it("reuseSameIdSet keeps the previous Set while the ids are the same", () => {
    const first = new Set(["a", "b"]);
    const sameIds = new Set(["b", "a"]);
    const kept = reuseSameIdSet(first, sameIds);
    console.info(`[#2461:id-set] same-ids kept=${kept === first}`);
    expect(kept).toBe(first);

    const added = new Set(["a", "b", "c"]);
    expect(reuseSameIdSet(first, added)).toBe(added);
    const swapped = new Set(["a", "c"]);
    expect(reuseSameIdSet(first, swapped)).toBe(swapped);
    const empty = new Set<string>();
    expect(reuseSameIdSet(null, empty)).toBe(empty);
  });

  it("reuseUnchangedActiveJobStates gives a new object only to the title whose import moved", () => {
    const tick1 = buildDashboardActiveJobsByMediaId([job("a", 10), job("b", 40), job("c", 70)]);
    const tick2 = reuseUnchangedActiveJobStates(
      tick1,
      buildDashboardActiveJobsByMediaId([job("a", 10), job("b", 45), job("c", 70)])
    );
    console.info(
      `[#2461:job-states] tick2 a-kept=${tick2.get("a") === tick1.get("a")} b-kept=${tick2.get("b") === tick1.get("b")} c-kept=${tick2.get("c") === tick1.get("c")}`
    );
    expect(tick2).not.toBe(tick1);
    expect(tick2.get("a")).toBe(tick1.get("a"));
    expect(tick2.get("c")).toBe(tick1.get("c"));
    expect(tick2.get("b")).not.toBe(tick1.get("b"));
    expect(tick2.get("b")?.progressSum).toBe(45);

    const tick3 = reuseUnchangedActiveJobStates(
      tick2,
      buildDashboardActiveJobsByMediaId([job("a", 10), job("b", 45), job("c", 70)])
    );
    expect(tick3).toBe(tick2);

    const finished = buildDashboardActiveJobsByMediaId([job("a", 10), job("b", 45)]);
    const tick4 = reuseUnchangedActiveJobStates(tick3, finished);
    expect(tick4).not.toBe(tick3);
    expect([...tick4.keys()]).toEqual(["a", "b"]);
    expect(tick4.get("a")).toBe(tick1.get("a"));
  });
});
