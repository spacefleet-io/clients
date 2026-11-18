// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { MediaDetails } from "../src/renderer/src/lib/libraryDb";
import { buildMediaDetailsFixture } from "./_helpers/mediaDetailsFixture";
import { getProgressBand } from "@space/shared/progressBand";
import {
  buildEpisodeCreditsMap,
  buildEpisodeResumeMap,
  buildMediaFilePresence,
  collectAvailableMovieQualities,
  collectEpisodeQualities,
  countEpisodeTracks,
  isEpisodeResumeCompleted,
  playableNowPresence,
  resolveDefaultPlayableEpisodeId,
  resolveDefaultPlayableEpisodeLabel,
} from "../src/renderer/src/lib/mediaDetailsProcessing";

const baseTvDetails = (): MediaDetails =>
  buildMediaDetailsFixture({
    id: "show-1",
    type: "tv",
    title: "Better Call Saul",
    files: [
      { id: "file-101", season: 1, episode: 1 },
      { id: "file-103", season: 1, episode: 3 },
    ],
    formats: [
      { id: "fmt-101-1080", fileId: "file-101", quality: "1080p", initKey: "init-101-1080", chunks: ["c1"] },
      { id: "fmt-101-360", fileId: "file-101", quality: "360p", initKey: "init-101-360", chunks: ["c2"] },
      { id: "fmt-103-720", fileId: "file-103", quality: "720p", initKey: "init-103-720", chunks: ["c3"] },
    ],
    episodes: [
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1 },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2 },
      { id: "ep-3", seasonNumber: 1, episodeNumber: 3 },
    ],
    audioTracks: [
      { id: "aud-1", episodeId: "ep-1", language: "en", label: "English", initKey: "aud-init-1", chunks: ["a1"] },
      { id: "aud-2", episodeId: "ep-1", language: "fr", label: "French", initKey: "aud-init-2", chunks: ["a2"] },
      { id: "aud-3", episodeId: "ep-3", language: "en", label: "English", initKey: "aud-init-3", chunks: ["a3"] },
    ],
    subtitleTracks: [
      { id: "sub-1", episodeId: "ep-3", language: "en", label: "English" },
      { id: "sub-2", episodeId: "ep-3", language: "fr", label: "French" },
    ],
  });

// Six-playable-episode show for testing the picker against multi-episode
// resume scenarios (the user-reported "1% on early episodes, 34% on later"
// shape requires more than three episodes to express).
const sixEpisodeTvDetails = (): MediaDetails =>
  buildMediaDetailsFixture({
    id: "show-six",
    type: "tv",
    title: "Long Show",
    files: Array.from({ length: 6 }, (_, idx) => ({
      id: `file-${idx + 1}`,
      season: 1,
      episode: idx + 1,
    })),
    formats: Array.from({ length: 6 }, (_, idx) => ({
      id: `fmt-${idx + 1}`,
      fileId: `file-${idx + 1}`,
      quality: "1080p",
      initKey: `init-${idx + 1}`,
      chunks: [`c${idx + 1}`],
    })),
    episodes: Array.from({ length: 6 }, (_, idx) => ({
      id: `ep-${idx + 1}`,
      seasonNumber: 1,
      episodeNumber: idx + 1,
    })),
    audioTracks: Array.from({ length: 6 }, (_, idx) => ({
      id: `aud-${idx + 1}`,
      episodeId: `ep-${idx + 1}`,
      language: "en",
      label: "English",
      initKey: `aud-init-${idx + 1}`,
      chunks: [`a${idx + 1}`],
    })),
    subtitleTracks: [],
  });

describe("mediaDetailsProcessing", () => {
  it("[@bugfix][@regression-proof] picks the earliest non-completed playable episode in show order, ignoring recency and progress magnitude", () => {
    // ep-1 (S1E01) sits at 24% (touched 09:00). ep-3 (S1E03) is further
    // along at 52% AND touched more recently (10:00). Under the in-order
    // rule, ep-1 still wins: earliest non-completed playable episode is
    // the only signal — recency and progress depth are intentionally ignored.
    const details = baseTvDetails();
    const filePresence = buildMediaFilePresence(details);
    const resumeMap = buildEpisodeResumeMap(
      details,
      (key) => {
        if (key === "episode_resume_v1:ep-1") {
          return { value: JSON.stringify({ progressPct: 24, updatedAt: "2026-03-25T09:00:00Z" }) };
        }
        if (key === "episode_resume_v1:ep-3") {
          return { value: JSON.stringify({ progressPct: 52, updatedAt: "2026-03-25T10:00:00Z" }) };
        }
        return null;
      },
      true
    );

    const defaultEpisodeId = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries);

    // Diagnostic: surface the resume entries the picker actually saw so a
    // future failure points to the right layer (picker vs. resume-map build).
    expect(resumeMap.entries.size).toBe(2);
    expect(resumeMap.entries.get("ep-1")?.progressPct).toBe(24);
    expect(resumeMap.entries.get("ep-3")?.progressPct).toBe(52);
    expect(defaultEpisodeId).toBe("ep-1");
    expect(resolveDefaultPlayableEpisodeLabel(details, defaultEpisodeId)).toBe("S1E01");
  });

  it("[@bugfix][@regression-proof] user-reported scenario: 1% ghost-touches on earlier episodes + 34% on a later one — ep-3 (earliest non-completed) wins, not ep-6", () => {
    // Reported by user 2026-05-25: a 6-episode show where ep-1, ep-2, ep-5
    // are completed (99%), ep-3 and ep-4 each sit at 1% (likely accidental
    // taps — below the resume-prompt floor of 2%, so they'd play from start
    // anyway), and ep-6 is genuinely in-progress at 34%. Prior to the fix
    // the picker used a "most recently updated in-progress wins" sort and
    // returned ep-6. The in-order rule must return ep-3 — the earliest
    // non-completed playable episode.
    const details = sixEpisodeTvDetails();
    const filePresence = buildMediaFilePresence(details);
    const resumeMap = buildEpisodeResumeMap(
      details,
      (key) => {
        if (key === "episode_resume_v1:ep-1")
          return { value: JSON.stringify({ progressPct: 99, updatedAt: "2026-05-25T08:00:00Z" }) };
        if (key === "episode_resume_v1:ep-2")
          return { value: JSON.stringify({ progressPct: 99, updatedAt: "2026-05-25T08:30:00Z" }) };
        if (key === "episode_resume_v1:ep-3")
          return { value: JSON.stringify({ progressPct: 1, updatedAt: "2026-05-25T09:00:00Z" }) };
        if (key === "episode_resume_v1:ep-4")
          return { value: JSON.stringify({ progressPct: 1, updatedAt: "2026-05-25T09:05:00Z" }) };
        if (key === "episode_resume_v1:ep-5")
          return { value: JSON.stringify({ progressPct: 99, updatedAt: "2026-05-25T09:30:00Z" }) };
        if (key === "episode_resume_v1:ep-6")
          return { value: JSON.stringify({ progressPct: 34, updatedAt: "2026-05-25T10:00:00Z" }) };
        return null;
      },
      true
    );

    const defaultEpisodeId = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries);

    // Diagnostic: confirm all 6 entries reached the picker before asserting
    // the pick. If size != 6 the failure is in the resume map, not the picker.
    expect(resumeMap.entries.size).toBe(6);
    expect(filePresence.episodeHasFile.size).toBe(6);
    expect(defaultEpisodeId).toBe("ep-3");
    expect(resolveDefaultPlayableEpisodeLabel(details, defaultEpisodeId)).toBe("S1E03");
  });

  it("[@bugfix][@regression-proof] restarts from the first playable episode when every playable episode is completed (>= 95%)", () => {
    // ep-1 at 99% and ep-3 at 96% are both past the completion threshold,
    // so no episode qualifies as non-completed. The picker falls back to
    // the first playable episode (ep-1) for a restart-from-start.
    const details = baseTvDetails();
    const filePresence = buildMediaFilePresence(details);
    const resumeMap = buildEpisodeResumeMap(
      details,
      (key) => {
        if (key === "episode_resume_v1:ep-1") {
          return { value: JSON.stringify({ progressPct: 99, updatedAt: "2026-03-25T09:00:00Z" }) };
        }
        if (key === "episode_resume_v1:ep-3") {
          return { value: JSON.stringify({ progressPct: 96, updatedAt: "2026-03-25T10:00:00Z" }) };
        }
        return null;
      },
      true
    );

    const defaultEpisodeId = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries);

    expect(defaultEpisodeId).toBe("ep-1");
  });

  it("[@bugfix][@regression-proof] returns empty entries with isReady=false while the playback stage is still hydrating", () => {
    const details = baseTvDetails();
    const getSharedSetting = (key: string) => {
      if (key === "episode_resume_v1:ep-1") {
        return { value: JSON.stringify({ progressPct: 52, updatedAt: "2026-03-25T09:00:00Z" }) };
      }
      if (key === "episode_resume_v1:ep-3") {
        return { value: JSON.stringify({ progressPct: 24, updatedAt: "2026-03-25T10:00:00Z" }) };
      }
      return null;
    };

    const result = buildEpisodeResumeMap(details, getSharedSetting, false);

    expect(result.isReady).toBe(false);
    expect(result.entries.size).toBe(0);
  });

  it("[@bugfix][@regression-proof] returns populated entries with isReady=true once the playback stage is hydrated", () => {
    const details = baseTvDetails();
    const getSharedSetting = (key: string) => {
      if (key === "episode_resume_v1:ep-1") {
        return { value: JSON.stringify({ progressPct: 52, updatedAt: "2026-03-25T09:00:00Z" }) };
      }
      if (key === "episode_resume_v1:ep-3") {
        return { value: JSON.stringify({ progressPct: 24, updatedAt: "2026-03-25T10:00:00Z" }) };
      }
      return null;
    };

    const result = buildEpisodeResumeMap(details, getSharedSetting, true);

    expect(result.isReady).toBe(true);
    expect(result.entries.size).toBe(2);
    expect(result.entries.get("ep-1")?.progressPct).toBe(52);
    expect(result.entries.get("ep-3")?.progressPct).toBe(24);
  });

  it("[@bugfix][@regression-proof] filters out 0% resume entries but keeps finished (100%) ones when playback is ready", () => {
    const details = baseTvDetails();
    const getSharedSetting = (key: string) => {
      if (key === "episode_resume_v1:ep-1") {
        return { value: JSON.stringify({ progressPct: 0, updatedAt: "2026-03-25T09:00:00Z" }) };
      }
      if (key === "episode_resume_v1:ep-2") {
        return { value: JSON.stringify({ progressPct: 100, updatedAt: "2026-03-25T09:00:00Z" }) };
      }
      if (key === "episode_resume_v1:ep-3") {
        return { value: JSON.stringify({ progressPct: 42, updatedAt: "2026-03-25T10:00:00Z" }) };
      }
      return null;
    };

    const result = buildEpisodeResumeMap(details, getSharedSetting, true);

    expect(result.isReady).toBe(true);
    expect(result.entries.size).toBe(2);
    expect(result.entries.has("ep-1")).toBe(false);
    expect(result.entries.get("ep-2")?.progressPct).toBe(100);
    expect(result.entries.get("ep-3")?.progressPct).toBe(42);
  });

  // @bugfix @regression-proof @req PLAY-RESUME-02
  // Walk finding #5 (2026-11-12): an episode played to its true end is saved at
  // 100 % (mpv keep-open lands time-pos >= duration, e.g. 150.037 / 150.021 s).
  // buildEpisodeResumeMap dropped `pct >= 100`, so the row showed nothing (as if
  // never played) and the picker offered the finished episode again.
  it("[@bugfix][@regression-proof] an episode played to its true end shows Watched and the picker moves to the next one", () => {
    const details = baseTvDetails();
    const stored: Record<string, string> = {
      // Exactly what desktop saved in the hand repro: time-pos overshoots duration.
      "episode_resume_v1:ep-1": JSON.stringify({
        progressPct: 100.01077649129124,
        updatedAt: "2026-11-12T20:00:00Z",
        positionSeconds: 150.037167,
        durationSeconds: 150.021,
      }),
    };
    const getSharedSetting = (key: string) => (key in stored ? { value: stored[key] } : null);

    const result = buildEpisodeResumeMap(details, getSharedSetting, true);
    const entry = result.entries.get("ep-1");
    console.info("[PLAY-RESUME-02] resume map entries", Object.fromEntries(result.entries));

    expect(entry, "finished episode must stay in the resume map").toBeDefined();
    expect(entry?.progressPct).toBe(100);
    const band = getProgressBand(entry!.progressPct, {
      positionSeconds: entry!.positionSeconds,
      durationSeconds: entry!.durationSeconds ?? null,
    });
    console.info("[PLAY-RESUME-02] band for finished episode", band);
    expect(band).toBe("watched");

    const filePresence = buildMediaFilePresence(details);
    const defaultEpisodeId = resolveDefaultPlayableEpisodeId(details, filePresence, result.entries);
    console.info("[PLAY-RESUME-02] default playable episode", defaultEpisodeId);
    // ep-2 has no file in the fixture; ep-3 is the next playable one.
    expect(defaultEpisodeId).toBe("ep-3");
    // The header reads "Play", not "Resume", for a finished episode (and for a never-started one).
    expect(isEpisodeResumeCompleted(entry, undefined)).toBe(true);
    expect(isEpisodeResumeCompleted(undefined, undefined)).toBe(false);
    expect(isEpisodeResumeCompleted({ progressPct: 40, updatedAtMs: 0 }, undefined)).toBe(false);
  });

  it("[@bugfix][@regression-proof] derives playable file presence and per-episode qualities deterministically", () => {
    const details = baseTvDetails();

    const filePresence = buildMediaFilePresence(details);
    const episodeQualities = collectEpisodeQualities(details);

    expect(filePresence.seasonHasFiles.get(1)).toBe(true);
    expect(filePresence.episodeHasFile.has("1-1")).toBe(true);
    expect(filePresence.episodeHasFile.has("1-2")).toBe(false);
    expect(filePresence.episodeHasFile.has("1-3")).toBe(true);
    expect(episodeQualities.get("1-1")?.map((f) => f.quality)).toEqual(["1080p", "360p"]);
    expect(episodeQualities.get("1-3")?.map((f) => f.quality)).toEqual(["720p"]);
  });

  it("[@bugfix][@regression-proof] counts episode-scoped audio and subtitle tracks without mixing movie tracks", () => {
    const details = baseTvDetails();

    expect(countEpisodeTracks(details.audioTracks).get("ep-1")).toBe(2);
    expect(countEpisodeTracks(details.audioTracks).get("ep-3")).toBe(1);
    expect(countEpisodeTracks(details.subtitleTracks).get("ep-3")).toBe(2);
  });

  it("[@bugfix][@regression-proof] collects movie qualities from the movie-scoped file set", () => {
    const movie = buildMediaDetailsFixture({
      id: "movie-1",
      type: "movie",
      title: "Arrival",
      files: [
        { id: "movie-file", season: null, episode: null },
        { id: "bonus-file", season: 1, episode: 1 },
      ],
      formats: [
      { id: "fmt-1", fileId: "movie-file", quality: "1080p", initKey: "init-movie-1", chunks: ["m1"] },
      { id: "fmt-2", fileId: "movie-file", quality: "480p", initKey: "init-movie-2", chunks: ["m2"] },
      { id: "fmt-3", fileId: "bonus-file", quality: "144p", initKey: "init-bonus", chunks: ["m3"] },
      ],
      episodes: [],
      audioTracks: [],
      subtitleTracks: [],
    });

    expect(collectAvailableMovieQualities(movie).map((f) => f.quality)).toEqual(["1080p", "480p"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: credits-aware completion (the metadata service skip-markers)
// ---------------------------------------------------------------------------
//
// Phase 1 introduced a flat 95 % completion ceiling. Phase 2 upgrades the
// boundary using the per-episode credits-start timestamp from the metadata service —
// the semantically correct "watched past credits" signal. The picker, the
// resume prompt, and the band UI all consume the same isEpisodeCompleted
// helper in @space/shared/playbackResume so the three layers can't drift.
//
// Tests cover:
//   1. buildEpisodeCreditsMap — extract credits markers + per-episode duration
//   2. resolveDefaultPlayableEpisodeId with credits map — earliest non-watched
//   3. graceful fallback to the legacy 95 % rule when markers are absent
//   4. mixed coverage: some episodes have credits, others don't
//   5. backward-compat with new payload fields (positionSeconds/durationSeconds)
//
// These tests MUST FAIL against the pre-Phase-2 code because:
//   - buildEpisodeCreditsMap did not exist (import would be undefined).
//   - resolveDefaultPlayableEpisodeId had a 3-arg signature; the 4th arg
//     would be ignored, so an 85%-watched-past-credits episode would NOT be
//     skipped by the picker.

// Show fixture with skipMarkers + per-file durationSeconds. Each episode
// has one matching file (S1E1→file-1, S1E2→file-2, S1E3→file-3) and one
// 1080p format with a known durationSeconds (3600 s = 60 min). The credits
// markers are placed at known seconds so the test assertions can be exact.
const tvDetailsWithCredits = (params?: {
  // Override credits markers (omitting an episode means it has no credits).
  creditsByEpisode?: Map<string, number>;
}): MediaDetails => {
  const creditsByEpisode = params?.creditsByEpisode ?? new Map([
    ["ep-1", 3120], // credits start at 52:00
    ["ep-2", 3120],
    ["ep-3", 3120],
  ]);
  return buildMediaDetailsFixture({
    id: "show-credits",
    type: "tv",
    title: "Long Show with Credits Data",
    files: [
      { id: "file-1", season: 1, episode: 1 },
      { id: "file-2", season: 1, episode: 2 },
      { id: "file-3", season: 1, episode: 3 },
    ],
    formats: [
      { id: "fmt-1", fileId: "file-1", quality: "1080p", durationSeconds: 3600, initKey: "init-1", chunks: ["c1"] },
      { id: "fmt-2", fileId: "file-2", quality: "1080p", durationSeconds: 3600, initKey: "init-2", chunks: ["c2"] },
      { id: "fmt-3", fileId: "file-3", quality: "1080p", durationSeconds: 3600, initKey: "init-3", chunks: ["c3"] },
    ],
    episodes: [
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1 },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2 },
      { id: "ep-3", seasonNumber: 1, episodeNumber: 3 },
    ],
    // Each episode needs an audioTrack with initKey + chunks for
    // getPlayableEpisodeKeySet to consider it playable.
    audioTracks: [
      { id: "aud-1", episodeId: "ep-1", language: "en", label: "English", initKey: "aud-init-1", chunks: ["a1"] },
      { id: "aud-2", episodeId: "ep-2", language: "en", label: "English", initKey: "aud-init-2", chunks: ["a2"] },
      { id: "aud-3", episodeId: "ep-3", language: "en", label: "English", initKey: "aud-init-3", chunks: ["a3"] },
    ],
    subtitleTracks: [],
    skipMarkers: Array.from(creditsByEpisode.entries()).map(([episodeId, startSeconds], idx) => ({
      id: `mk-${idx + 1}`,
      mediaId: "show-credits",
      episodeId,
      type: "credits",
      startSeconds,
      endSeconds: 3600,
      source: "metadata",
      confidence: 0.95,
      createdAt: "2026-05-25T00:00:00Z",
      updatedAt: "2026-05-25T00:00:00Z",
    })),
  });
};

describe("Phase 2 — buildEpisodeCreditsMap (service-derived per-episode credits-start + duration)", () => {
  it("[@bugfix][@regression-proof] extracts a credits-start + duration entry for each episode with a credits marker", () => {
    const details = tvDetailsWithCredits();
    const map = buildEpisodeCreditsMap(details);
    console.info(`[credits-map] size=${map.size} keys=${[...map.keys()].join(",")}`);
    expect(map.size).toBe(3);
    expect(map.get("ep-1")).toEqual({ creditsStartSeconds: 3120, durationSeconds: 3600 });
    expect(map.get("ep-2")).toEqual({ creditsStartSeconds: 3120, durationSeconds: 3600 });
    expect(map.get("ep-3")).toEqual({ creditsStartSeconds: 3120, durationSeconds: 3600 });
  });

  it("[@bugfix][@regression-proof] ignores intro markers (only credits markers contribute to the completion ceiling)", () => {
    const details = tvDetailsWithCredits();
    // Append intro markers — they must NOT appear in the credits map.
    (details.skipMarkers as Array<Record<string, unknown>>).push(
      {
        id: "mk-intro-1",
        mediaId: "show-credits",
        episodeId: "ep-1",
        type: "intro",
        startSeconds: 30,
        endSeconds: 90,
        source: "metadata",
        confidence: 0.9,
        createdAt: "2026-05-25T00:00:00Z",
        updatedAt: "2026-05-25T00:00:00Z",
      }
    );
    const map = buildEpisodeCreditsMap(details);
    console.info(`[credits-map:intro-filter] size=${map.size} ep-1=${JSON.stringify(map.get("ep-1"))}`);
    // ep-1 should still resolve to the credits start (3120), NOT the intro start (30).
    expect(map.get("ep-1")?.creditsStartSeconds).toBe(3120);
    expect(map.size).toBe(3); // still 3 entries — intro didn't add a fake one
  });

  it("[@bugfix][@regression-proof] picks the EARLIEST credits-start when multiple credits markers exist on the same episode", () => {
    const details = tvDetailsWithCredits({
      creditsByEpisode: new Map([["ep-1", 3120]]),
    });
    // Add a SECOND credits marker for ep-1 with a LATER start. The map
    // must keep the earlier one (the safer "past credits" boundary).
    (details.skipMarkers as Array<Record<string, unknown>>).push({
      id: "mk-credits-late",
      mediaId: "show-credits",
      episodeId: "ep-1",
      type: "credits",
      startSeconds: 3300,
      endSeconds: 3600,
      source: "metadata",
      confidence: 0.85,
      createdAt: "2026-05-25T00:00:00Z",
      updatedAt: "2026-05-25T00:00:00Z",
    });
    const map = buildEpisodeCreditsMap(details);
    console.info(`[credits-map:multi] ep-1=${JSON.stringify(map.get("ep-1"))}`);
    expect(map.get("ep-1")?.creditsStartSeconds).toBe(3120);
  });

  it("[@bugfix][@regression-proof] omits episodes with no credits marker (consumer falls back to 95 % rule for those)", () => {
    // Only ep-2 has credits data; ep-1 and ep-3 should be omitted entirely.
    const details = tvDetailsWithCredits({
      creditsByEpisode: new Map([["ep-2", 3120]]),
    });
    const map = buildEpisodeCreditsMap(details);
    console.info(`[credits-map:partial] size=${map.size} keys=${[...map.keys()].join(",")}`);
    expect(map.size).toBe(1);
    expect(map.has("ep-1")).toBe(false);
    expect(map.has("ep-2")).toBe(true);
    expect(map.has("ep-3")).toBe(false);
  });

  it("[@bugfix][@regression-proof] omits episodes whose files have no durationSeconds (cannot decide completion in seconds)", () => {
    const details = tvDetailsWithCredits({
      creditsByEpisode: new Map([["ep-1", 3120], ["ep-2", 3120]]),
    });
    // Strip ep-2's format duration. The map MUST omit ep-2 — without
    // duration, the credits-start can't be compared against a derived
    // position. ep-1 still has duration and stays in the map.
    const formats = details.formats as Array<{ fileId: string; durationSeconds: number | null }>;
    const ep2Format = formats.find((f) => f.fileId === "file-2");
    if (ep2Format) ep2Format.durationSeconds = null;
    const map = buildEpisodeCreditsMap(details);
    console.info(`[credits-map:no-dur] size=${map.size} ep-1=${JSON.stringify(map.get("ep-1"))} ep-2=${JSON.stringify(map.get("ep-2"))}`);
    expect(map.has("ep-1")).toBe(true);
    expect(map.has("ep-2")).toBe(false);
  });

  it("[@bugfix][@regression-proof] returns an empty map for non-TV details (movies are out of scope for the picker)", () => {
    const movie = {
      id: "movie-1",
      type: "movie",
      title: "Arrival",
      files: [{ id: "movie-file", season: null, episode: null }],
      formats: [{ id: "fmt-1", fileId: "movie-file", quality: "1080p", durationSeconds: 6240, initKey: "init", chunks: ["c"] }],
      episodes: [],
      audioTracks: [],
      subtitleTracks: [],
      skipMarkers: [{
        id: "mk-1",
        mediaId: "movie-1",
        episodeId: null,
        type: "credits",
        startSeconds: 6000,
        endSeconds: 6240,
        source: "metadata",
        confidence: 0.95,
        createdAt: "",
        updatedAt: "",
      }],
    } as unknown as MediaDetails;
    const map = buildEpisodeCreditsMap(movie);
    expect(map.size).toBe(0);
  });

  it("[@bugfix][@regression-proof] returns an empty map when details is null", () => {
    expect(buildEpisodeCreditsMap(null).size).toBe(0);
  });

  it("[@bugfix][@regression-proof] ignores credits markers with episodeId=null (movie-scoped, out of the per-episode picker context)", () => {
    const details = tvDetailsWithCredits({ creditsByEpisode: new Map() });
    (details.skipMarkers as Array<Record<string, unknown>>).push({
      id: "mk-movie",
      mediaId: "show-credits",
      episodeId: null,
      type: "credits",
      startSeconds: 3120,
      endSeconds: 3600,
      source: "metadata",
      confidence: 0.95,
      createdAt: "",
      updatedAt: "",
    });
    expect(buildEpisodeCreditsMap(details).size).toBe(0);
  });
});

describe("Phase 2 — resolveDefaultPlayableEpisodeId with credits-aware completion", () => {
  // Helper to populate the shared-setting getter with episode_resume_v1
  // entries. The picker reads pct + optional positionSeconds via
  // buildEpisodeResumeMap; the credits-aware path then compares position
  // (or derived pct*duration) against creditsStartSeconds.
  type ResumeFixture = { pct: number; positionSeconds?: number; durationSeconds?: number };
  const makeGetSharedSetting = (resumes: Record<string, ResumeFixture>) =>
    (key: string) => {
      const id = key.startsWith("episode_resume_v1:") ? key.slice("episode_resume_v1:".length) : null;
      if (id && resumes[id]) {
        const r = resumes[id];
        const payload: Record<string, unknown> = {
          progressPct: r.pct,
          updatedAt: `2026-05-25T${String(parseInt(id.replace(/\D/g, "") || "0") % 24).padStart(2, "0")}:00:00Z`,
        };
        if (r.positionSeconds !== undefined) payload.positionSeconds = r.positionSeconds;
        if (r.durationSeconds !== undefined) payload.durationSeconds = r.durationSeconds;
        return { value: JSON.stringify(payload) };
      }
      return null;
    };

  it("[@bugfix][@regression-proof] credits-aware picker: 88% watched past credits skips episode and picks the next non-completed one", () => {
    // ep-1: 88 % / position 3168 s — PAST credits at 3120. Legacy 95 % rule
    // would say "in-progress" and the picker would pick ep-1. Phase 2 must
    // recognize the user already saw the credits and pick ep-2 instead.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    console.info(`[picker:credits-aware] resumeMap.size=${resumeMap.entries.size} creditsMap.size=${creditsMap.size}`);
    console.info(`[picker:credits-aware] ep-1 resume=${JSON.stringify(resumeMap.entries.get("ep-1"))}`);
    console.info(`[picker:credits-aware] ep-1 credits=${JSON.stringify(creditsMap.get("ep-1"))}`);
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    expect(id).toBe("ep-2");
  });

  it("[@bugfix][@regression-proof] credits-aware picker: 88% NOT past credits keeps episode (legacy 95% would also keep it; this pins the negative case)", () => {
    // ep-1 watched to 50 % (1800 s) — well before credits at 3120 s. Both
    // rules agree: ep-1 stays in-progress, picker picks ep-1.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 50, positionSeconds: 1800, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    console.info(`[picker:in-progress] id=${id}`);
    expect(id).toBe("ep-1");
  });

  it("[@bugfix][@regression-proof] credits-aware picker uses POSITION SECONDS, not pct*duration, when both differ (re-transcode drift)", () => {
    // Persisted positionSeconds is 3000 (before credits at 3120). The pct
    // (88) * duration (3600) computes 3168 (past credits). The credits-
    // aware rule MUST trust the persisted seconds, so ep-1 is still
    // in-progress and the picker returns ep-1.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88, positionSeconds: 3000, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    console.info(`[picker:position-authoritative] id=${id}`);
    expect(id).toBe("ep-1");
  });

  it("[@bugfix][@regression-proof] no credits map → falls back to the legacy 95% rule (Phase 1 behavior preserved)", () => {
    // Legacy 3-arg signature: no credits map passed. ep-1 at 88 % is below
    // the flat 95 % ceiling → in-progress → picker picks ep-1. This pins
    // the backward-compat path against future refactors.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    // Note: NO 4th arg → legacy 95 % rule.
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries);
    console.info(`[picker:legacy-no-credits] id=${id} (expect ep-1 — credits-aware path disabled)`);
    expect(id).toBe("ep-1");
  });

  it("[@bugfix][@regression-proof] mixed coverage: ep-1 has credits + completed past them; ep-2 has NO credits + below 95 % → picker picks ep-2 (correctly using each episode's available signal)", () => {
    // ep-1: 88 % at 3168 s past credits=3120 → completed via credits-aware.
    // ep-2: 80 %, no credits marker → in-progress via fallback (80 < 95).
    // Picker walks in order: ep-1 completed → skip; ep-2 in-progress → pick.
    const details = tvDetailsWithCredits({
      creditsByEpisode: new Map([["ep-1", 3120]]),
    });
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
      "ep-2": { pct: 80, positionSeconds: 2880, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    console.info(`[picker:mixed-coverage] creditsMap.size=${creditsMap.size} (only ep-1 has credits)`);
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    expect(id).toBe("ep-2");
  });

  it("[@bugfix][@regression-proof] legacy resume payload (no positionSeconds) still works credits-aware via pct*duration", () => {
    // Older client wrote { progressPct, updatedAt } without positionSeconds.
    // Picker must derive position = pct/100 * duration (via creditsMap's
    // durationSeconds since the resume entry has no duration of its own)
    // and STILL apply the credits-aware check.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88 }, // legacy payload — no positionSeconds, no durationSeconds
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    console.info(`[picker:legacy-payload] ep-1 entry=${JSON.stringify(resumeMap.entries.get("ep-1"))}`);
    console.info(`[picker:legacy-payload] ep-1 credits=${JSON.stringify(creditsMap.get("ep-1"))}`);
    // 88 % * 3600 = 3168 s, past credits at 3120 → completed → picker
    // skips ep-1 and picks ep-2.
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    expect(id).toBe("ep-2");
  });

  it("[@bugfix][@regression-proof] all episodes completed via credits → fallback to first playable (restart-from-start)", () => {
    // Every episode watched past its credits. The picker can't find a
    // non-completed candidate; it must fall back to "play from ep-1 for
    // a restart" rather than returning null.
    const details = tvDetailsWithCredits();
    const filePresence = buildMediaFilePresence(details);
    const getSharedSetting = makeGetSharedSetting({
      "ep-1": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
      "ep-2": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
      "ep-3": { pct: 88, positionSeconds: 3168, durationSeconds: 3600 },
    });
    const resumeMap = buildEpisodeResumeMap(details, getSharedSetting, true);
    const creditsMap = buildEpisodeCreditsMap(details);
    const id = resolveDefaultPlayableEpisodeId(details, filePresence, resumeMap.entries, creditsMap);
    console.info(`[picker:all-completed] id=${id}`);
    expect(id).toBe("ep-1"); // first playable (restart)
  });
});

describe("Phase 2 — buildEpisodeResumeMap additive payload fields (positionSeconds + durationSeconds)", () => {
  // The persisted JSON gained two optional fields in Phase 2:
  //   positionSeconds (absolute watched time)
  //   durationSeconds (episode duration captured at write time)
  // Old payloads (pct + updatedAt only) must parse cleanly and surface as
  // entries with the seconds fields unset.

  const details = (): MediaDetails => ({
    id: "show-1",
    type: "tv",
    title: "Show",
    files: [{ id: "file-1", season: 1, episode: 1 }],
    formats: [{ id: "fmt-1", fileId: "file-1", quality: "1080p", durationSeconds: 3600, initKey: "init-1", chunks: ["c1"] }],
    episodes: [{ id: "ep-1", seasonNumber: 1, episodeNumber: 1 }],
    audioTracks: [],
    subtitleTracks: [],
    skipMarkers: [],
  } as unknown as MediaDetails);

  it("[@bugfix][@regression-proof] reads positionSeconds + durationSeconds when present in the JSON payload", () => {
    const result = buildEpisodeResumeMap(
      details(),
      () => ({ value: JSON.stringify({ progressPct: 50, updatedAt: "2026-05-25T10:00:00Z", positionSeconds: 1800, durationSeconds: 3600 }) }),
      true
    );
    const entry = result.entries.get("ep-1");
    console.info(`[resume-map:new-payload] entry=${JSON.stringify(entry)}`);
    expect(entry?.progressPct).toBe(50);
    expect(entry?.positionSeconds).toBe(1800);
    expect(entry?.durationSeconds).toBe(3600);
  });

  it("[@bugfix][@regression-proof] omits positionSeconds + durationSeconds when payload is the legacy pct-only shape", () => {
    const result = buildEpisodeResumeMap(
      details(),
      () => ({ value: JSON.stringify({ progressPct: 50, updatedAt: "2026-05-25T10:00:00Z" }) }),
      true
    );
    const entry = result.entries.get("ep-1");
    console.info(`[resume-map:legacy-payload] entry=${JSON.stringify(entry)}`);
    expect(entry?.progressPct).toBe(50);
    expect(entry?.positionSeconds).toBeUndefined();
    expect(entry?.durationSeconds).toBeUndefined();
  });

  it("[@bugfix][@regression-proof] ignores garbage positionSeconds (NaN / negative / non-numeric) — entry has no seconds field", () => {
    const result = buildEpisodeResumeMap(
      details(),
      () => ({ value: JSON.stringify({ progressPct: 50, updatedAt: "2026-05-25T10:00:00Z", positionSeconds: -1, durationSeconds: "garbage" }) }),
      true
    );
    const entry = result.entries.get("ep-1");
    console.info(`[resume-map:garbage] entry=${JSON.stringify(entry)}`);
    expect(entry?.progressPct).toBe(50);
    expect(entry?.positionSeconds).toBeUndefined();
    expect(entry?.durationSeconds).toBeUndefined();
  });

  it("[@bugfix][@regression-proof] zero positionSeconds is accepted (user rewound to start) but zero durationSeconds is rejected", () => {
    const result = buildEpisodeResumeMap(
      details(),
      () => ({ value: JSON.stringify({ progressPct: 50, updatedAt: "2026-05-25T10:00:00Z", positionSeconds: 0, durationSeconds: 0 }) }),
      true
    );
    const entry = result.entries.get("ep-1");
    console.info(`[resume-map:zero-bounds] entry=${JSON.stringify(entry)}`);
    expect(entry?.positionSeconds).toBe(0); // legitimate at start
    expect(entry?.durationSeconds).toBeUndefined(); // duration must be > 0
  });
});

// @req OFFL-PLAY-03: offline, only the episodes downloaded on this computer can start; the default episode follows.
describe("playableNowPresence", () => {
  it("keeps every episode with a file online and only downloaded ones offline", () => {
    const details = baseTvDetails();
    const presence = buildMediaFilePresence(details);
    const online = playableNowPresence(presence, true, new Set());
    const offline = playableNowPresence(presence, false, new Set(["1-3"]));
    const offlineNothing = playableNowPresence(presence, false, new Set());
    console.info(
      JSON.stringify({
        test: "OFFL-PLAY-03 presence",
        withFile: [...presence.episodeHasFile],
        offline: [...offline.episodeHasFile],
        offlineSeasons: [...offline.seasonHasFiles.keys()],
        offlineNothing: [...offlineNothing.episodeHasFile],
        defaultOffline: resolveDefaultPlayableEpisodeId(details, offline, new Map()),
      }),
    );
    expect(online).toBe(presence);
    expect([...offline.episodeHasFile]).toEqual(["1-3"]);
    expect(offline.seasonHasFiles.get(1)).toBe(true);
    expect(offlineNothing.episodeHasFile.size).toBe(0);
    expect(offlineNothing.seasonHasFiles.size).toBe(0);
    expect(resolveDefaultPlayableEpisodeId(details, presence, new Map())).toBe("ep-1");
    expect(resolveDefaultPlayableEpisodeId(details, offline, new Map())).toBe("ep-3");
    expect(resolveDefaultPlayableEpisodeId(details, offlineNothing, new Map())).toBeNull();
  });
});
