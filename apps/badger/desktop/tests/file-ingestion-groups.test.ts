// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildFileIngestionMergedGroups,
  buildFileIngestionTvSeasonState,
} from "../src/renderer/src/components/fileIngestionGroups";

// Dump the computed grouping/season state on assertion failure. try/catch so
// a dump failure can't mask the real expect().
const dumpFileIngestionGroupsSnapshot = (label: string, payload: Record<string, unknown>) => {
  try {
    console.error(`=== [file-ingestion-groups:${label}] snapshot ===`);
    for (const [k, v] of Object.entries(payload)) {
      console.error(`${k}:\n${JSON.stringify(v, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("fileIngestionGroups", () => {
  it("[@bugfix][@regression-proof] groups tv candidates by show and sorts episodes in canonical order", () => {
    console.info("[file-ingestion-groups:merge] merging 2 tv eps (3,1) + 1 movie candidate");
    const groups = buildFileIngestionMergedGroups(
      [
        {
          id: "ep3",
          status: "ready",
          match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
          parsed: { season: 1, episode: 3 },
        },
        {
          id: "ep1",
          status: "ready",
          match: { id: 60059, type: "tv" as const, title: "Better Call Saul" },
          parsed: { season: 1, episode: 1 },
        },
        {
          id: "movie1",
          status: "ready",
          match: { id: 78, type: "movie" as const, title: "Blade Runner" },
          parsed: {},
        },
      ],
      (groupCandidates) => ({ count: groupCandidates.length })
    );

    const showGroup = groups.find((group) => group.match.type === "tv");
    const epNumbers = showGroup?.episodeGroups?.map((episode) => episode.episode);
    const epCounts = showGroup?.episodeGroups?.map((episode) => episode.count);
    console.info(
      `[file-ingestion-groups:merge] groups.length=${groups.length} episodes=${JSON.stringify(epNumbers)} counts=${JSON.stringify(epCounts)}`,
    );
    if (
      groups.length !== 2 ||
      JSON.stringify(epNumbers) !== JSON.stringify([1, 3]) ||
      JSON.stringify(epCounts) !== JSON.stringify([1, 1])
    ) {
      dumpFileIngestionGroupsSnapshot("merge", { groups });
    }
    expect(groups).toHaveLength(2);
    expect(epNumbers).toEqual([1, 3]);
    expect(epCounts).toEqual([1, 1]);
  });

  it("[@bugfix][@regression-proof] resolves active tv season state from stable primitive keys", () => {
    console.info("[file-ingestion-groups:season-state] resolving season state for active key '1'");
    const state = buildFileIngestionTvSeasonState(
      [
        { id: "unknown-1", season: null, episode: null },
        { id: "s1e1", season: 1, episode: 1 },
        { id: "s1e3", season: 1, episode: 3 },
        { id: "s2e1", season: 2, episode: 1 },
      ],
      "1"
    );

    const episodeIds = state.episodes.map((episode) => episode.id);
    console.info(
      `[file-ingestion-groups:season-state] seasons=${JSON.stringify(state.seasons)} activeKey=${state.activeKey} episodes=${JSON.stringify(episodeIds)}`,
    );
    if (
      JSON.stringify(state.seasons) !== JSON.stringify(["1", "2", "unknown"]) ||
      state.activeKey !== "1" ||
      JSON.stringify(episodeIds) !== JSON.stringify(["s1e1", "s1e3"])
    ) {
      dumpFileIngestionGroupsSnapshot("season-state", { state });
    }
    expect(state.seasons).toEqual(["1", "2", "unknown"]);
    expect(state.activeKey).toBe("1");
    expect(episodeIds).toEqual(["s1e1", "s1e3"]);
  });
});
