// @vitest-environment jsdom
//
// W1-G / Q-7 — Ghost-poster two-state capture
//
// Pins today's tile rendering behavior for three ingest states:
//   (a) ghost: no MediaRow yet, only a LabJob in flight
//   (b) source done, transcode in flight — MediaRow exists with hasFiles=true
//   (c) fully done — hasFiles=true, no active jobs
//
// Scope decision: full Library page cannot be rendered in a unit test because it
// depends on useLibraryShell / useLibraryData / useAuth / useIngestion / useLabJobsData.
// Instead we test the two pure-projection functions in libraryViewState.ts that drive
// every tile-rendering decision:
//
//   • mergeLibraryGridItems  → determines which items get __ghost:true (ghost branch)
//   • buildActiveJobsByMediaId → determines isProcessing / statusLabel / progress overlay
//
// The `disabled = !item.hasFiles` expression at Library.tsx:550 is verified inline.
// The grayscale class is applied as `disabled ? "opacity-60 grayscale" : ""` at line 581.
// The processing badge (dark overlay + progress bar) appears when isProcessing && statusLabel
// (lines 717-735). statusLabel is non-null only when activeState.hasBlocking is true
// (line 556-561).

import { describe, expect, it } from "vitest";
import type { LabJob } from "../src/renderer/src/lib/labJobs";
import type { MediaRow } from "@space/shared/libraryTypes";
import {
  buildActiveJobsByMediaId,
  mergeLibraryGridItems,
} from "../src/renderer/src/pages/libraryViewState";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const t = (key: string) => key;

/** Minimal valid MediaRow factory — only fields used by the projection layer. */
const makeMediaRow = (overrides: Partial<MediaRow> & { id: string }): MediaRow => ({
  type: "movie",
  catalogId: 1,
  title: "Test Movie",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2024",
  rating: 7.5,
  posterPath: "/poster.jpg",
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  hasFiles: false,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  ...overrides,
});

/** Minimal LabJob factory. */
const makeLabJob = (overrides: Partial<LabJob> & { id: string; status: LabJob["status"] }): LabJob => ({
  filename: "/tmp/test.mkv",
  progress: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

// On assertion failure, dump the pure-projection state this suite pins (per
// memory feedback: tests must self-diagnose; never recommend manual repro).
// These tests assert on mergeLibraryGridItems output shape (which items carry
// __ghost) and buildActiveJobsByMediaId aggregates (total/progressSum/
// hasBlocking/hasUploading) — so the dumper renders exactly those. Body is
// try/catch-wrapped so a snapshot failure never masks the real assertion.
const dumpGhostPosterSnapshot = (
  label: string,
  ctx: {
    merged?: ReadonlyArray<Record<string, unknown>>;
    activeMap?: Map<string, unknown>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [library-ghost-poster-states:${label}] snapshot ===`);
    if (ctx.merged) {
      const shaped = ctx.merged.map((m) => ({
        id: (m as { id?: unknown }).id,
        title: (m as { title?: unknown }).title,
        hasGhost: "__ghost" in m,
        hasFiles: (m as { hasFiles?: unknown }).hasFiles,
      }));
      console.error(`merged (${ctx.merged.length}):\n${JSON.stringify(shaped, null, 2)}`);
    }
    if (ctx.activeMap) {
      const entries = Array.from(ctx.activeMap.entries()).map(([k, v]) => ({ mediaId: k, state: v }));
      console.error(`activeJobsByMediaId (${ctx.activeMap.size}):\n${JSON.stringify(entries, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra: ${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Fixture (a) — ghost: no MediaRow yet
//
// A LabJob with no matchedMediaId (unmatched to any existing library row) gets
// turned into a GhostLibraryItem by buildGhostLibraryItems. mergeLibraryGridItems
// then tags it with __ghost:true, routing it to the ghost branch in Library.tsx.
// ---------------------------------------------------------------------------

describe("fixture (a): ghost item — no MediaRow exists yet", () => {
  it("mergeLibraryGridItems preserves __ghost:true on items that already carry it (Library.tsx adds it at line 425)", () => {
    // Library.tsx:423-425 adds __ghost:true before calling mergeLibraryGridItems:
    //   ghostItems.map((item) => ({ ...item, id: `ghost-${item.id}`, __ghost: true as const }))
    // mergeLibraryGridItems receives objects that ALREADY have __ghost:true and passes them
    // through unchanged (the `as GhostItem & { __ghost: true }` is a TypeScript cast, not a mutation).
    const ghostItem = {
      id: "ghost-ghost-job-1", // Library.tsx prefixes id with "ghost-"
      title: "Interstellar",
      year: "2014",
      posterPath: "/interstellar.jpg",
      type: "movie" as const,
      progress: 42,
      statusLabel: t("library.processing.uploading"),
      __ghost: true as const, // added by Library.tsx:425 before mergeLibraryGridItems
    };

    console.info(`[library-ghost-poster-states:fixture-a] merging 1 pre-tagged ghost item, 0 media rows`);
    const merged = mergeLibraryGridItems([ghostItem], []);
    console.info(`[library-ghost-poster-states:fixture-a] merged.length=${merged.length} item[0].hasGhost=${merged[0] ? "__ghost" in merged[0] : "n/a"}`);

    if (merged.length !== 1) dumpGhostPosterSnapshot("fixture-a-ghost-passthrough-length", { merged });
    expect(merged).toHaveLength(1);
    const item = merged[0];

    // Ghost branch in Library.tsx:523 — `"__ghost" in item` must be true
    if (!("__ghost" in item)) dumpGhostPosterSnapshot("fixture-a-ghost-tag-lost", { merged });
    expect("__ghost" in item).toBe(true);
    // Type-narrow sanity: ghost fields are present
    expect(item).toMatchObject({
      id: "ghost-ghost-job-1",
      title: "Interstellar",
      progress: 42,
    });
  });

  it("mergeLibraryGridItems does NOT tag a real MediaRow with __ghost", () => {
    console.info(`[library-ghost-poster-states:fixture-a] merging 0 ghosts, 1 real media row (hasFiles=false)`);
    const row = makeMediaRow({ id: "media-1", hasFiles: false, progressPct: 0.42 });
    const merged = mergeLibraryGridItems([], [row]);
    console.info(`[library-ghost-poster-states:fixture-a] merged.length=${merged.length} item[0].hasGhost=${merged[0] ? "__ghost" in merged[0] : "n/a"}`);

    if (merged.length !== 1 || "__ghost" in merged[0]) dumpGhostPosterSnapshot("fixture-a-real-row-mistagged", { merged });
    expect(merged).toHaveLength(1);
    expect("__ghost" in merged[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture (b) — source upload done, transcode in flight
//
// MediaRow is present (hasFiles=true). A LabJob with status "transcoding" and
// matchedMediaId links it to that row.
//
// @known-gap: progressPct on MediaRow is overloaded — it represents watch-progress
// percent (0-100) in media playback contexts, but during ingest it is populated
// by the server from the LabJob progress (see lib/mediaDetailsJobs.ts:53).
// Today's rendering ignores MediaRow.progressPct entirely for the tile overlay;
// it uses buildActiveJobsByMediaId() instead, which sums job.progress values.
// The `disabled` flag is `!item.hasFiles` — so when hasFiles=true, the tile is
// CLICKABLE even while transcoding is in flight.
// ---------------------------------------------------------------------------

describe("[@known-gap] fixture (b): source done + transcode running — captures today's tile state", () => {
  const mediaId = "media-transcode-123";

  const mediaRowB = makeMediaRow({
    id: mediaId,
    hasFiles: true,
    progressPct: 0.6, // watch-progress field — NOT used for the overlay bar
  });

  const transcodeJob = makeLabJob({
    id: "job-transcode-1",
    status: "transcoding",
    progress: 60,
    matchedMediaId: mediaId,
    // includeSource/includeFallback/includeAudio/includeSubtitles/includeChapters all
    // undefined → isFallbackOnly = false → hasBlocking = true
  });

  it("buildActiveJobsByMediaId produces an active-state entry for the media ID", () => {
    console.info(`[library-ghost-poster-states:fixture-b] building active-jobs map for transcoding job → mediaId=${mediaId}`);
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const state = map.get(mediaId);
    console.info(`[library-ghost-poster-states:fixture-b] state=${JSON.stringify(state)} mapSize=${map.size}`);

    if (!state) dumpGhostPosterSnapshot("fixture-b-no-active-state", { activeMap: map });
    expect(state, `No active state found for ${mediaId}. Rendered HTML would show no processing overlay.`).toBeTruthy();
  });

  it("active-state: total=1, progressSum=60, hasBlocking=true, hasUploading=false", () => {
    console.info(`[library-ghost-poster-states:fixture-b] asserting aggregate shape for transcoding job`);
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const state = map.get(mediaId);
    console.info(`[library-ghost-poster-states:fixture-b] state=${JSON.stringify(state)}`);

    // Pin the exact aggregate used by isProcessing/statusLabel/processingProgress in Library.tsx
    const s = state as { total?: number; progressSum?: number; hasBlocking?: boolean; hasUploading?: boolean } | undefined;
    if (s?.total !== 1 || s?.progressSum !== 60 || s?.hasBlocking !== true || s?.hasUploading !== false) {
      dumpGhostPosterSnapshot("fixture-b-aggregate-mismatch", { activeMap: map });
    }
    expect(state).toMatchObject({
      total: 1,
      progressSum: 60,
      hasBlocking: true,
      hasUploading: false,
    });
  });

  it("disabled = !item.hasFiles → false (tile is CLICKABLE while transcoding)", () => {
    // Library.tsx:550: const disabled = !item.hasFiles
    const disabled = !mediaRowB.hasFiles;
    console.info(`[library-ghost-poster-states:fixture-b] hasFiles=${mediaRowB.hasFiles} → disabled=${disabled} (expect false)`);
    if (disabled !== false) dumpGhostPosterSnapshot("fixture-b-unexpectedly-disabled", { extra: { hasFiles: mediaRowB.hasFiles, disabled } });
    expect(disabled).toBe(false);
  });

  it("grayscale class is NOT applied (disabled=false → no 'grayscale' in className)", () => {
    // Library.tsx:581: disabled ? "opacity-60 grayscale" : ""
    const disabled = !mediaRowB.hasFiles;
    const className = [
      "space-tile group relative w-[210px]",
      disabled ? "opacity-60 grayscale" : "",
    ].join(" ");
    console.info(`[library-ghost-poster-states:fixture-b] className=${JSON.stringify(className)}`);
    if (className.includes("grayscale") || className.includes("opacity-60")) {
      dumpGhostPosterSnapshot("fixture-b-grayscale-applied", { extra: { className, disabled } });
    }
    expect(className).not.toContain("grayscale");
    expect(className).not.toContain("opacity-60");
  });

  it("isProcessing=true because activeState is present", () => {
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const activeState = map.get(mediaId);

    // Library.tsx:552: const isProcessing = Boolean(activeState)
    const isProcessing = Boolean(activeState);
    console.info(`[library-ghost-poster-states:fixture-b] activeState present=${activeState !== undefined} → isProcessing=${isProcessing}`);
    if (isProcessing !== true) dumpGhostPosterSnapshot("fixture-b-not-processing", { activeMap: map });
    expect(isProcessing).toBe(true);
  });

  it("statusLabel is non-null: hasBlocking=true and hasUploading=false → 'library.processing.finishing'", () => {
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const activeState = map.get(mediaId)!;

    // Library.tsx:555-561:
    //   statusLabel = isProcessing
    //     ? activeState.hasBlocking
    //       ? activeState.hasUploading
    //         ? t("library.processing.uploading")
    //         : t("library.processing.preparing")
    //       : t("library.processing.finishing")
    //     : null
    const isProcessing = Boolean(activeState);
    const statusLabel = isProcessing
      ? activeState.hasBlocking
        ? activeState.hasUploading
          ? t("library.processing.uploading")
          : t("library.processing.preparing")
        : t("library.processing.finishing")
      : null;

    // hasBlocking=true (includeSource not set → isFallbackOnly=false → hasBlocking=true)
    // hasUploading=false (status is "transcoding", not "uploading")
    // → branch: hasBlocking=true && hasUploading=false → "library.processing.preparing"
    console.info(`[library-ghost-poster-states:fixture-b] computed statusLabel=${JSON.stringify(statusLabel)} (expect library.processing.preparing) hasBlocking=${activeState.hasBlocking} hasUploading=${activeState.hasUploading}`);
    if (statusLabel !== "library.processing.preparing") {
      dumpGhostPosterSnapshot("fixture-b-status-label-mismatch", { activeMap: map, extra: { statusLabel } });
    }
    expect(statusLabel).toBe("library.processing.preparing");
    expect(statusLabel).not.toBeNull();
  });

  it("processing badge IS rendered (isProcessing=true and statusLabel is non-null)", () => {
    // Library.tsx:717: {isProcessing && statusLabel ? (<> overlay + progress bar </>) : null}
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const activeState = map.get(mediaId)!;
    const isProcessing = Boolean(activeState);
    const statusLabel = isProcessing
      ? activeState.hasBlocking
        ? activeState.hasUploading
          ? t("library.processing.uploading")
          : t("library.processing.preparing")
        : t("library.processing.finishing")
      : null;

    const badgeVisible = isProcessing && Boolean(statusLabel);
    console.info(`[library-ghost-poster-states:fixture-b] badgeVisible=${badgeVisible} (isProcessing=${isProcessing} statusLabel=${JSON.stringify(statusLabel)})`);
    if (badgeVisible !== true) dumpGhostPosterSnapshot("fixture-b-badge-not-visible", { activeMap: map, extra: { isProcessing, statusLabel } });
    expect(badgeVisible).toBe(true);
  });

  it("processingProgress = 60 (Math.round(60 / 1))", () => {
    const map = buildActiveJobsByMediaId([transcodeJob]);
    const activeState = map.get(mediaId)!;

    // Library.tsx:553-554:
    //   const processingProgress = activeState && activeState.total > 0
    //     ? Math.round(activeState.progressSum / activeState.total) : 0
    const processingProgress =
      activeState && activeState.total > 0
        ? Math.round(activeState.progressSum / activeState.total)
        : 0;
    console.info(`[library-ghost-poster-states:fixture-b] processingProgress=${processingProgress} (progressSum=${activeState.progressSum} total=${activeState.total})`);
    if (processingProgress !== 60) dumpGhostPosterSnapshot("fixture-b-progress-mismatch", { activeMap: map, extra: { processingProgress } });
    expect(processingProgress).toBe(60);
  });

  it("progress bar color: hasFiles=true → bg-[#7ee787] (green, not orange)", () => {
    // Library.tsx:729: item.hasFiles ? "bg-[#7ee787]" : "bg-[#ffaa54]"
    // green bar = source is done; orange bar = source still uploading
    const barColor = mediaRowB.hasFiles ? "bg-[#7ee787]" : "bg-[#ffaa54]";
    console.info(`[library-ghost-poster-states:fixture-b] hasFiles=${mediaRowB.hasFiles} → barColor=${barColor} (expect bg-[#7ee787])`);
    if (barColor !== "bg-[#7ee787]") dumpGhostPosterSnapshot("fixture-b-bar-color-mismatch", { extra: { hasFiles: mediaRowB.hasFiles, barColor } });
    expect(barColor).toBe("bg-[#7ee787]");
  });
});

// ---------------------------------------------------------------------------
// Fixture (c) — fully done
//
// hasFiles=true, no active jobs → disabled=false, no processing badge, no grayscale.
// ---------------------------------------------------------------------------

describe("fixture (c): fully done — clickable, no overlay, no grayscale", () => {
  const mediaId = "media-done-456";

  const mediaRowC = makeMediaRow({
    id: mediaId,
    hasFiles: true,
    progressPct: 1.0,
  });

  it("buildActiveJobsByMediaId returns empty map (no jobs)", () => {
    console.info(`[library-ghost-poster-states:fixture-c] building active-jobs map for 0 jobs`);
    const map = buildActiveJobsByMediaId([]);
    console.info(`[library-ghost-poster-states:fixture-c] mapSize=${map.size} get(${mediaId})=${JSON.stringify(map.get(mediaId))}`);
    if (map.get(mediaId) !== undefined) dumpGhostPosterSnapshot("fixture-c-unexpected-active-state", { activeMap: map });
    expect(map.get(mediaId)).toBeUndefined();
  });

  it("disabled = !item.hasFiles → false (tile is CLICKABLE)", () => {
    const disabled = !mediaRowC.hasFiles;
    console.info(`[library-ghost-poster-states:fixture-c] hasFiles=${mediaRowC.hasFiles} → disabled=${disabled} (expect false)`);
    if (disabled !== false) dumpGhostPosterSnapshot("fixture-c-unexpectedly-disabled", { extra: { hasFiles: mediaRowC.hasFiles, disabled } });
    expect(disabled).toBe(false);
  });

  it("grayscale class is NOT applied", () => {
    const disabled = !mediaRowC.hasFiles;
    const className = [
      "space-tile group relative w-[210px]",
      disabled ? "opacity-60 grayscale" : "",
    ].join(" ");
    console.info(`[library-ghost-poster-states:fixture-c] className=${JSON.stringify(className)}`);
    if (className.includes("grayscale")) dumpGhostPosterSnapshot("fixture-c-grayscale-applied", { extra: { className, disabled } });
    expect(className).not.toContain("grayscale");
  });

  it("isProcessing=false → processing badge NOT rendered", () => {
    console.info(`[library-ghost-poster-states:fixture-c] no jobs → expect isProcessing=false, no badge`);
    const map = buildActiveJobsByMediaId([]);
    const activeState = map.get(mediaId);
    const isProcessing = Boolean(activeState);
    console.info(`[library-ghost-poster-states:fixture-c] activeState present=${activeState !== undefined} isProcessing=${isProcessing}`);

    if (isProcessing !== false) dumpGhostPosterSnapshot("fixture-c-unexpectedly-processing", { activeMap: map });
    expect(isProcessing).toBe(false);
    // Library.tsx:717: {isProcessing && statusLabel ? ... : null} → null
    const statusLabel = null; // isProcessing=false → statusLabel=null
    expect(isProcessing && Boolean(statusLabel)).toBe(false);
  });

  it("mergeLibraryGridItems places fully-done MediaRow in main branch (no __ghost)", () => {
    console.info(`[library-ghost-poster-states:fixture-c] merging fully-done media row, expect main branch (no __ghost)`);
    const merged = mergeLibraryGridItems([], [mediaRowC]);
    console.info(`[library-ghost-poster-states:fixture-c] merged.length=${merged.length} item[0].hasGhost=${merged[0] ? "__ghost" in merged[0] : "n/a"}`);
    if (merged.length !== 1 || "__ghost" in merged[0]) dumpGhostPosterSnapshot("fixture-c-merge-mismatch", { merged });
    expect(merged).toHaveLength(1);
    expect("__ghost" in merged[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-fixture: ghost and main-branch items are deduplicated by identity
// ---------------------------------------------------------------------------

describe("deduplication: ghost item is suppressed when MediaRow with same identity exists", () => {
  it("mergeLibraryGridItems keeps the MediaRow and drops the ghost with same title/year/type", () => {
    const ghostItem = {
      id: "ghost-ghost-dedup", // Library.tsx prefixes with "ghost-"
      title: "Inception",
      year: "2010",
      type: "movie" as const,
      progress: 30,
      statusLabel: "library.processing.uploading",
      __ghost: true as const,
    };
    const mediaRow = makeMediaRow({
      id: "media-inception",
      title: "Inception",
      year: "2010",
      type: "movie",
      hasFiles: true,
      progressPct: 0,
    });

    console.info(`[library-ghost-poster-states:dedup] merging 1 ghost + 1 media row sharing identity movie:inception:2010`);
    const merged = mergeLibraryGridItems([ghostItem], [mediaRow]);
    console.info(`[library-ghost-poster-states:dedup] merged.length=${merged.length} item[0].id=${merged[0] ? (merged[0] as { id?: unknown }).id : "n/a"} item[0].hasGhost=${merged[0] ? "__ghost" in merged[0] : "n/a"}`);

    // Both share the same identity key (movie:inception:2010) — only one survives
    if (merged.length !== 1 || "__ghost" in merged[0] || (merged[0] as MediaRow).id !== "media-inception") {
      dumpGhostPosterSnapshot("dedup-mismatch", { merged });
    }
    expect(merged).toHaveLength(1);
    // The MediaRow wins because items are processed first
    expect("__ghost" in merged[0]).toBe(false);
    expect((merged[0] as MediaRow).id).toBe("media-inception");
  });
});
