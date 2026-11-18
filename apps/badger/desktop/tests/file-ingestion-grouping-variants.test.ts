// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildFileIngestionMergedGroups } from "../src/renderer/src/components/fileIngestionGroups";

// Minimal summarize helper — mirrors the pattern used in file-ingestion-groups.test.ts
const summarize = (groupCandidates: unknown[]) => ({ count: groupCandidates.length });

// ---------------------------------------------------------------------------
// Candidate factories
// ---------------------------------------------------------------------------

const makeMovie = (id: string, tmdbId: number, title: string) => ({
  id,
  status: "ready" as const,
  match: { id: tmdbId, type: "movie" as const, title },
  parsed: {},
});

const makeTvEp = (
  id: string,
  tmdbId: number,
  showTitle: string,
  season: number,
  episode: number,
) => ({
  id,
  status: "ready" as const,
  match: { id: tmdbId, type: "tv" as const, title: showTitle },
  parsed: { season, episode },
});

// Subtitle candidate — kind="subtitle" is not part of fileIngestionGroups.ts's
// CandidateLike type, but we synthesise a structurally valid candidate that has
// a match so we can observe how today's grouping logic handles it.
const makeSubtitle = (
  id: string,
  matchId: number | null,
  matchType: "movie" | "tv" | null,
  matchTitle: string,
  parsed: { season?: number; episode?: number } = {},
) => ({
  id,
  status: "ready" as const,
  match: matchId !== null && matchType !== null ? { id: matchId, type: matchType, title: matchTitle } : null,
  parsed,
});

// ---------------------------------------------------------------------------
// Dump-on-failure helper
// ---------------------------------------------------------------------------

// Print the full input candidate set + the produced groups (with their nested
// episodeGroups + candidates) so a grouping regression is diagnosable from the
// log alone. Wrapped in try/catch so a dump error can't mask the assertion.
const dumpGroupingSnapshot = (label: string, candidates: unknown[], groups: unknown[]) => {
  try {
    console.error(`=== [file-ingestion-grouping-variants:${label}] snapshot ===`);
    console.error(`input candidates (${candidates.length}):\n${JSON.stringify(candidates, null, 2)}`);
    console.error(`produced groups (${groups.length}):\n${JSON.stringify(groups, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Grouping variant tests
// ---------------------------------------------------------------------------

describe("fileIngestionGroups — drag-drop projection variants", () => {
  // Case 1 — single movie
  it("1 movie file alone → 1 group, type=movie", () => {
    console.info("[file-ingestion-grouping-variants:case1] 1 movie (Orchard/903549) → expect 1 movie group");
    const candidates = [makeMovie("orchard", 903549, "Orchard")];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    if (groups.length !== 1) dumpGroupingSnapshot("case1", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(1);
    expect(groups[0]?.match.type).toBe("movie");
    expect(groups[0]?.match.id).toBe(903549);
  });

  // Case 2 — two movies, different titles
  it("2 movie files (different titles) → 2 groups, both movies", () => {
    console.info("[file-ingestion-grouping-variants:case2] 2 movies (Orchard/903549, Inception/27205) → expect 2 movie groups");
    const candidates = [makeMovie("orchard", 903549, "Orchard"), makeMovie("inception", 27205, "Inception")];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    if (groups.length !== 2 || !groups.every((g) => g.match.type === "movie")) {
      dumpGroupingSnapshot("case2", candidates, groups);
    }
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(2);
    expect(groups.every((g) => g.match.type === "movie")).toBe(true);
  });

  // Case 3 — one movie + one TV episode
  it("1 movie + 1 TV episode → 2 groups: 1 movie + 1 TV episode", () => {
    console.info("[file-ingestion-grouping-variants:case3] 1 movie (Orchard) + 1 tv ep (Saltmarsh S1E1) → expect 1 movie + 1 tv group");
    const candidates = [makeMovie("orchard", 903549, "Orchard"), makeTvEp("salt-s1e1", 907633, "Saltmarsh", 1, 1)];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    const movieGroup = groups.find((g) => g.match.type === "movie");
    const tvGroup = groups.find((g) => g.match.type === "tv");
    if (groups.length !== 2 || !movieGroup || !tvGroup) dumpGroupingSnapshot("case3", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(2);
    expect(movieGroup, "expected a movie group").toBeDefined();
    expect(tvGroup, "expected a TV group").toBeDefined();
  });

  // Case 4 — two TV episodes, same show, same season
  it("2 TV episodes same show same season → 1 TV group with 2 episodes", () => {
    console.info("[file-ingestion-grouping-variants:case4] Saltmarsh S1E1+S1E2 → expect 1 tv group / 2 episodes");
    const candidates = [
      makeTvEp("salt-s1e1", 907633, "Saltmarsh", 1, 1),
      makeTvEp("salt-s1e2", 907633, "Saltmarsh", 1, 2),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    const tvGroup = groups[0];
    if (groups.length !== 1 || tvGroup?.episodeGroups?.length !== 2) dumpGroupingSnapshot("case4", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(1);
    expect(tvGroup?.match.type).toBe("tv");
    expect(tvGroup?.episodeGroups, `episodeGroups: ${JSON.stringify(tvGroup?.episodeGroups)}`).toHaveLength(2);
    expect(tvGroup?.episodeGroups?.map((eg) => eg.episode)).toEqual([1, 2]);
  });

  // Case 5 — two TV episodes, same show, different seasons
  it("2 TV episodes same show different seasons → 1 TV group with 2 episodes across 2 seasons", () => {
    console.info("[file-ingestion-grouping-variants:case5] Saltmarsh S1E1+S2E1 → expect 1 tv group / 2 episodes across 2 seasons");
    const candidates = [
      makeTvEp("salt-s1e1", 907633, "Saltmarsh", 1, 1),
      makeTvEp("salt-s2e1", 907633, "Saltmarsh", 2, 1),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    const tvGroup = groups[0];
    if (groups.length !== 1 || tvGroup?.episodeGroups?.length !== 2) dumpGroupingSnapshot("case5", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(1);
    expect(tvGroup?.match.type).toBe("tv");
    expect(tvGroup?.episodeGroups).toHaveLength(2);
    // Episodes sorted: s1e1 comes before s2e1
    expect(tvGroup?.episodeGroups?.map((eg) => ({ season: eg.season, episode: eg.episode }))).toEqual([
      { season: 1, episode: 1 },
      { season: 2, episode: 1 },
    ]);
  });

  // Case 6 — two TV episodes, different shows
  it("2 TV episodes different shows → 2 separate TV groups", () => {
    console.info("[file-ingestion-grouping-variants:case6] Saltmarsh S1E1 + Lodgers S1E1 → expect 2 separate tv groups");
    const candidates = [
      makeTvEp("salt-s1e1", 907633, "Saltmarsh", 1, 1),
      makeTvEp("lod-s1e1", 901668, "Lodgers", 1, 1),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);
    if (groups.length !== 2 || !groups.every((g) => g.match.type === "tv")) dumpGroupingSnapshot("case6", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(2);
    expect(groups.every((g) => g.match.type === "tv")).toBe(true);
    const showIds = groups.map((g) => g.match.id).sort();
    expect(showIds).toEqual([901668, 907633].sort());
  });

  // Case 7 — movie + matching .fr.srt sidecar
  // Today's behavior: subtitle candidates land in the SAME movie group because
  // they share the match id. The grouping layer treats them as plain candidates
  // and does not attach them at any "sidecar" level — both appear in
  // group.candidates together.
  // @known-gap: sidecar subtitle should be attached to the movie group's track
  // list via fileIngestionTracks/buildTrackSummary, not left as a bare candidate
  it("1 movie + 1 matching .fr.srt sidecar → today groups them into 1 movie group (both as candidates)", () => {
    console.info("[file-ingestion-grouping-variants:case7] Orchard movie + orchard.fr.srt (same 903549) → expect 1 movie group / 2 candidates");
    const candidates = [
      makeMovie("orchard.mkv", 903549, "Orchard"),
      makeSubtitle("orchard.fr.srt", 903549, "movie", "Orchard"),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);

    // @known-gap: subtitle is not "attached" at track level — it is treated as
    // a plain candidate in the group. A proper implementation would fold it into
    // the movie group's external subtitle track list during summarize().
    if (groups.length !== 1 || groups[0]?.candidates?.length !== 2) dumpGroupingSnapshot("case7", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(1);
    expect(groups[0]?.match.type).toBe("movie");
    expect(groups[0]?.candidates).toHaveLength(2);
  });

  // Case 8 — TV episode + matching .srt sidecar
  // Today's behavior: same as case 7 but at TV group level. Both land in the
  // single TV group; the subtitle candidate appears in the episode group's
  // candidates array (it has an episode key matching the video).
  // @known-gap: external subtitle candidate should resolve to the correct episode
  // group and be surfaced as a subtitle track, not a raw video candidate.
  it("1 TV episode + 1 matching .srt sidecar → today groups them into 1 TV group (both as candidates)", () => {
    console.info("[file-ingestion-grouping-variants:case8] Saltmarsh S1E1 + salt-s1e1.srt → expect 1 tv group / ep S1E1 with 2 candidates");
    const candidates = [
      makeTvEp("salt-s1e1.mkv", 907633, "Saltmarsh", 1, 1),
      makeSubtitle("salt-s1e1.srt", 907633, "tv", "Saltmarsh", { season: 1, episode: 1 }),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);

    // @known-gap: external subtitle is not surfaced as a track on the episode
    // group — it lands as a raw candidate. buildTrackSummary() should handle it.
    const epGroup = groups[0]?.episodeGroups?.find((eg) => eg.season === 1 && eg.episode === 1);
    if (groups.length !== 1 || !epGroup || epGroup?.candidates?.length !== 2) dumpGroupingSnapshot("case8", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(1);
    expect(groups[0]?.match.type).toBe("tv");
    expect(epGroup, `episodeGroups: ${JSON.stringify(groups[0]?.episodeGroups)}`).toBeDefined();
    expect(epGroup?.candidates).toHaveLength(2);
  });

  // Case 9 — orphan .srt (no matching media dropped)
  // Today's behavior: the subtitle candidate has match=null, so it is filtered
  // out by the `candidate.match` guard in buildFileIngestionMergedGroups.
  // The result is 0 groups — the sidecar is silently dropped.
  // @known-gap: an orphan subtitle without a matched title should produce a
  // visible "unmatched subtitle" entry so the user knows it was ignored.
  it("1 .srt sidecar with no matching media → today produces 0 groups (orphan is filtered out)", () => {
    console.info("[file-ingestion-grouping-variants:case9] orphan orchard.fr.srt (match=null) → expect 0 groups (filtered out)");
    const candidates = [makeSubtitle("orchard.fr.srt", null, null, "")];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);

    // @known-gap: orphan subtitle is silently dropped rather than surfaced as
    // an "unmatched" item in the UI.
    if (groups.length !== 0) dumpGroupingSnapshot("case9", candidates, groups);
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(0);
  });

  // Case 10 — ambiguous sidecar: one subtitle file, two movie candidates with
  // different TMDB ids (different films). Today's grouping is purely by match.id
  // so the subtitle can only belong to one group (whichever id was assigned to it).
  // There is no filename-similarity disambiguation at this layer.
  // @known-gap: when a subtitle's filename is equidistant from two media
  // candidates the grouping layer should flag ambiguity rather than silently
  // placing it by TMDB id match alone.
  it("1 sidecar matching multiple candidates (ambiguous filename) → today assigns to exactly 1 group by match id", () => {
    console.info("[file-ingestion-grouping-variants:case10] Orchard + Inception + orchard.fr.srt(903549) → expect srt lands in Orchard group only");
    // Subtitle is matched to Orchard (903549), not Inception (27205)
    const candidates = [
      makeMovie("orchard.mkv", 903549, "Orchard"),
      makeMovie("inception.mkv", 27205, "Inception"),
      makeSubtitle("orchard.fr.srt", 903549, "movie", "Orchard"),
    ];
    const groups = buildFileIngestionMergedGroups(candidates, summarize);

    // @known-gap: no ambiguity is surfaced — the subtitle lands quietly in the
    // Orchard group. If the matched TMDB id were wrong (e.g. probe mis-identified
    // the file), there is no user-facing warning.
    const orchardGroup = groups.find((g) => g.match.id === 903549);
    const inceptionGroup = groups.find((g) => g.match.id === 27205);
    if (groups.length !== 2 || orchardGroup?.candidates?.length !== 2 || inceptionGroup?.candidates?.length !== 1) {
      dumpGroupingSnapshot("case10", candidates, groups);
    }
    expect(groups, `produced groups: ${JSON.stringify(groups)}`).toHaveLength(2);
    expect(orchardGroup?.candidates).toHaveLength(2); // mkv + srt
    expect(inceptionGroup?.candidates).toHaveLength(1); // mkv only
  });
});
