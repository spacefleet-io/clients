import { describe, expect, it } from "vitest";

import {
  getNextPlayableEpisode,
  getPlayableEpisodeKeySet,
  getPlayableEpisodesOrdered,
  getPreviousPlayableEpisode,
} from "@space/shared/playableEpisodes";
import { formatEpisodeCode, getEpisodePlaybackLabel, pickAutoplayEpisodeId } from "../src/renderer/src/lib/episodePlayback";

// Dump the playable-episode projection on assertion failure. Wrapped in
// try/catch so a dump failure can never mask the real expect().
const dumpEpisodePlaybackSnapshot = (label: string, media: unknown) => {
  try {
    const m = (media ?? {}) as Record<string, unknown>;
    const episodes = Array.isArray(m.episodes) ? (m.episodes as unknown[]) : [];
    const ordered = getPlayableEpisodesOrdered(media as never).map((ep) => ep.id);
    const keySet = Array.from(getPlayableEpisodeKeySet(media as never)).sort();
    console.error(`=== [episode-playback:${label}] snapshot ===`);
    console.error(`media.type=${String(m.type)} episodes.length=${episodes.length}`);
    console.error(`getPlayableEpisodesOrdered ids=${JSON.stringify(ordered)}`);
    console.error(`getPlayableEpisodeKeySet=${JSON.stringify(keySet)}`);
    console.error(`raw episodes:\n${JSON.stringify(episodes, null, 2)}`);
    console.error(`formats:\n${JSON.stringify(m.formats ?? null)}`);
    console.error(`audioTracks:\n${JSON.stringify(m.audioTracks ?? null)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("episode playback helpers", () => {
  const media = {
    type: "tv",
    episodes: [
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1, name: "Pilot" },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2, name: "Second" },
      { id: "ep-3", seasonNumber: 1, episodeNumber: 3, name: "Third" },
      { id: "ep-4", seasonNumber: 2, episodeNumber: 1, name: "Fourth" },
    ],
    files: [
      { id: "file-2", season: 1, episode: 2 },
      { id: "file-3", season: 1, episode: 3 },
      { id: "file-4", season: 2, episode: 1 },
    ],
    formats: [
      { id: "fmt-2", fileId: "file-2", initKey: "init-2", chunks: [{ key: "chunk-2" }] },
      { id: "fmt-3", fileId: "file-3", initKey: "init-3", chunks: [{ key: "chunk-3" }] },
      { id: "fmt-4", fileId: "file-4", initKey: null, chunks: [] },
    ],
    audioTracks: [
      { id: "audio-2", episodeId: "ep-2", initKey: "audio-init-2", chunks: [{ key: "audio-2" }] },
      { id: "audio-3", episodeId: "ep-3", initKey: "audio-init-3", chunks: [{ key: "audio-3" }] },
      { id: "audio-4", episodeId: "ep-4", initKey: "audio-init-4", chunks: [{ key: "audio-4" }] },
    ],
  } as any;

  it("orders only playable episodes by season and episode number", () => {
    console.info("[episode-playback:order] computing getPlayableEpisodesOrdered");
    const ordered = getPlayableEpisodesOrdered(media).map((episode) => episode.id);
    console.info(`[episode-playback:order] ordered ids=${JSON.stringify(ordered)}`);
    if (JSON.stringify(ordered) !== JSON.stringify(["ep-2", "ep-3"])) {
      dumpEpisodePlaybackSnapshot("order", media);
    }
    expect(ordered).toEqual(["ep-2", "ep-3"]);
  });

  it("[@bugfix][@regression-proof] requires playable formats and audio tracks before treating a tv episode as playable", () => {
    console.info("[episode-playback:key-set] computing getPlayableEpisodeKeySet");
    const keySet = Array.from(getPlayableEpisodeKeySet(media)).sort();
    console.info(`[episode-playback:key-set] keys=${JSON.stringify(keySet)}`);
    if (JSON.stringify(keySet) !== JSON.stringify(["1:2", "1:3"])) {
      dumpEpisodePlaybackSnapshot("key-set", media);
    }
    expect(keySet).toEqual(["1:2", "1:3"]);
  });

  it("finds the next playable episode from the current active episode", () => {
    console.info("[episode-playback:next] computing getNextPlayableEpisode for ep-2/ep-3/ep-4/ep-1");
    const next2 = getNextPlayableEpisode(media, "ep-2")?.id;
    const next3 = getNextPlayableEpisode(media, "ep-3");
    const next4 = getNextPlayableEpisode(media, "ep-4");
    const next1 = getNextPlayableEpisode(media, "ep-1");
    console.info(
      `[episode-playback:next] next(ep-2)=${String(next2)} next(ep-3)=${JSON.stringify(next3)} next(ep-4)=${JSON.stringify(next4)} next(ep-1)=${JSON.stringify(next1)}`,
    );
    if (next2 !== "ep-3" || next3 !== null || next4 !== null || next1 !== null) {
      dumpEpisodePlaybackSnapshot("next", media);
    }
    expect(next2).toBe("ep-3");
    expect(next3).toBeNull();
    expect(next4).toBeNull();
    expect(next1).toBeNull();
  });

  // @req PLAY-OVL-03[badger-desktop]
  it("finds the previous playable episode, none before the first uploaded one or on a movie", () => {
    const prev3 = getPreviousPlayableEpisode(media, "ep-3")?.id;
    const prev2 = getPreviousPlayableEpisode(media, "ep-2");
    const prev1 = getPreviousPlayableEpisode(media, "ep-1");
    const prevMovie = getPreviousPlayableEpisode({ ...media, type: "movie" }, "ep-3");
    console.info(
      `[episode-playback:previous] prev(ep-3)=${String(prev3)} prev(ep-2)=${JSON.stringify(prev2)} prev(ep-1)=${JSON.stringify(prev1)} prev(movie)=${JSON.stringify(prevMovie)}`,
    );
    if (prev3 !== "ep-2" || prev2 !== null || prev1 !== null || prevMovie !== null) {
      dumpEpisodePlaybackSnapshot("previous", media);
    }
    expect(prev3).toBe("ep-2");
    expect(prev2).toBeNull();
    expect(prev1).toBeNull();
    expect(prevMovie).toBeNull();
  });

  // @req PLAY-OVL-03[badger-desktop]
  it("the previous/next-episode buttons skip season 0 specials unless a special is playing; autoplay order keeps them", () => {
    // Hand-built library fixture: only the fields the playable-episode helpers read.
    type ShowFixture = Parameters<typeof getPreviousPlayableEpisode>[0];
    const uploaded = (id: string, season: number, episode: number) => ({
      episode: { id, seasonNumber: season, episodeNumber: episode, name: id },
      file: { id: `file-${id}`, season, episode },
      format: { id: `fmt-${id}`, fileId: `file-${id}`, initKey: `init-${id}`, chunks: [{ key: `c-${id}` }] },
      audio: { id: `audio-${id}`, episodeId: id, initKey: `ainit-${id}`, chunks: [{ key: `a-${id}` }] },
    });
    const rows = [uploaded("s0e1", 0, 1), uploaded("s0e2", 0, 2), uploaded("s1e1", 1, 1), uploaded("s1e2", 1, 2)];
    const show = {
      type: "tv",
      episodes: rows.map((row) => row.episode),
      files: rows.map((row) => row.file),
      formats: rows.map((row) => row.format),
      audioTracks: rows.map((row) => row.audio),
    } as unknown as ShowFixture;
    const seen = {
      prevOfS1E1: getPreviousPlayableEpisode(show, "s1e1")?.id ?? null,
      prevOfS1E2: getPreviousPlayableEpisode(show, "s1e2")?.id ?? null,
      prevOfS0E2: getPreviousPlayableEpisode(show, "s0e2")?.id ?? null,
      nextOfS0E2: getNextPlayableEpisode(show, "s0e2")?.id ?? null,
      nextOfS1E1: getNextPlayableEpisode(show, "s1e1")?.id ?? null,
      ordered: getPlayableEpisodesOrdered(show).map((episode) => episode.id),
    };
    console.info(`[episode-playback:specials] ${JSON.stringify(seen)}`);
    expect(seen.prevOfS1E1, "S1E1 with an uploaded S0E1: no Previous").toBeNull();
    expect(seen.prevOfS1E2).toBe("s1e1");
    expect(seen.prevOfS0E2, "a special steps to the previous special").toBe("s0e1");
    expect(seen.nextOfS0E2, "the last special steps on to S1E1 (autoplay order unchanged)").toBe("s1e1");
    expect(seen.nextOfS1E1).toBe("s1e2");
    expect(seen.ordered).toEqual(["s0e1", "s0e2", "s1e1", "s1e2"]);
  });

  it("formats stable episode labels for playback surfaces", () => {
    console.info("[episode-playback:label] formatEpisodeCode(3,7) + getEpisodePlaybackLabel(ep[1])");
    const code = formatEpisodeCode(3, 7);
    const label = getEpisodePlaybackLabel(media.episodes[1]);
    console.info(`[episode-playback:label] code=${code} label=${label}`);
    if (code !== "S3E07" || label !== "S1E02 - Second") {
      dumpEpisodePlaybackSnapshot("label", media);
    }
    expect(code).toBe("S3E07");
    expect(label).toBe("S1E02 - Second");
  });
});

// ---------------------------------------------------------------------------
// pickAutoplayEpisodeId — the "one Play click" episode selector
// ---------------------------------------------------------------------------
//
// This function backs the poster Play button: given a MediaDetails and a
// caller-supplied resume-data lookup, it returns the episode ID a single click
// should resume into, or null for non-TV / file-less shows.
//
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal MediaDetails-compatible TV show fixture.
 * Only the fields read by pickAutoplayEpisodeId are required.
 */
type MinimalMedia = {
  type: string;
  episodes: { id: string; seasonNumber: number; episodeNumber: number; name?: string }[];
  files: { id: string; season: number | null; episode: number | null }[];
};

function makeTvShow(
  episodes: { id: string; s: number; e: number }[],
  fileEpisodes?: { s: number; e: number }[],
): MinimalMedia {
  const episodeList = episodes.map(({ id, s, e }) => ({
    id,
    seasonNumber: s,
    episodeNumber: e,
    name: `Episode ${id}`,
  }));
  const resolvedFileEpisodes = fileEpisodes ?? episodes.map(({ s, e }) => ({ s, e }));
  const files = resolvedFileEpisodes.map(({ s, e }, i) => ({
    id: `file-${i}`,
    season: s,
    episode: e,
  }));
  return { type: "tv", episodes: episodeList, files };
}

/** Build a resume JSON string for use as getResumeRaw return value. */
function resumeJson(progressPct: number, updatedAt?: string): string {
  return JSON.stringify({ progressPct, updatedAt: updatedAt ?? "2024-01-01T00:00:00.000Z" });
}

/** A no-resume lookup — no episode has any stored resume data. */
const noResume = (_id: string): string | undefined => undefined;

describe("pickAutoplayEpisodeId", () => {
  // -------------------------------------------------------------------------
  // Movie guard
  // -------------------------------------------------------------------------

  it("returns null for a movie (type !== tv)", () => {
    console.info("[phase] movie guard — type=movie");
    const movie = { type: "movie", episodes: [], files: [] } as unknown as MinimalMedia;
    const result = pickAutoplayEpisodeId(movie as any, noResume);
    console.info("[result] pickAutoplayEpisodeId(movie) =", result);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty / no files
  // -------------------------------------------------------------------------

  it("returns null for a TV show with no files at all", () => {
    console.info("[phase] TV show with no files");
    const show = { type: "tv", episodes: [{ id: "ep-1", seasonNumber: 1, episodeNumber: 1 }], files: [] };
    const result = pickAutoplayEpisodeId(show as any, noResume);
    console.info("[result] no-files result =", result);
    expect(result).toBeNull();
  });

  it("returns null for a TV show whose episodes have no matching file entry", () => {
    console.info("[phase] TV show: episodes exist but files reference different season/episode numbers");
    const show = {
      type: "tv",
      episodes: [{ id: "ep-1", seasonNumber: 1, episodeNumber: 1 }],
      // File references S2E1 — no match for ep-1 (S1E1)
      files: [{ id: "file-1", season: 2, episode: 1 }],
    };
    const result = pickAutoplayEpisodeId(show as any, noResume);
    console.info("[result] mismatched-file result =", result);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // No resume data → first file-backed episode in season/episode order
  // -------------------------------------------------------------------------

  it("returns the first file-backed episode in season+episode order when there is no resume data", () => {
    console.info("[phase] no-resume → first episode S1E01");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
      { id: "ep-s2e1", s: 2, e: 1 },
    ]);
    const result = pickAutoplayEpisodeId(show as any, noResume);
    console.info("[result] first-episode result =", result);
    expect(result).toBe("ep-s1e1");
  });

  it("respects season+episode sort order regardless of the order episodes appear in the array", () => {
    console.info("[phase] out-of-order episodes array → must still return S1E01");
    const show = makeTvShow([
      { id: "ep-s2e1", s: 2, e: 1 },   // listed first
      { id: "ep-s1e2", s: 1, e: 2 },
      { id: "ep-s1e1", s: 1, e: 1 },   // listed last
    ]);
    const result = pickAutoplayEpisodeId(show as any, noResume);
    console.info("[result] out-of-order episodes result =", result, "(expected ep-s1e1)");
    expect(result).toBe("ep-s1e1");
  });

  // -------------------------------------------------------------------------
  // Episodes without a file are excluded from selection
  // -------------------------------------------------------------------------

  it("skips episodes that have no file entry and still picks the correct first playable one", () => {
    console.info("[phase] episode ep-no-file has no file — must never be returned");
    const show: MinimalMedia = {
      type: "tv",
      episodes: [
        { id: "ep-no-file", seasonNumber: 1, episodeNumber: 1 },
        { id: "ep-has-file", seasonNumber: 1, episodeNumber: 2 },
      ],
      files: [
        // Only ep-has-file (S1E2) has a matching file; ep-no-file (S1E1) has none
        { id: "file-1", season: 1, episode: 2 },
      ],
    };
    const result = pickAutoplayEpisodeId(show as any, noResume);
    console.info("[result] no-file-episode result =", result, "(expected ep-has-file, never ep-no-file)");
    expect(result).toBe("ep-has-file");
    expect(result).not.toBe("ep-no-file");
  });

  // -------------------------------------------------------------------------
  // In-progress detection: most-recently-updated wins
  // -------------------------------------------------------------------------

  it("returns the in-progress episode with the most recent updatedAt", () => {
    console.info("[phase] multiple in-progress episodes → most-recent updatedAt wins");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
      { id: "ep-s1e3", s: 1, e: 3 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": resumeJson(30, "2024-01-01T10:00:00.000Z"), // in-progress, older
      "ep-s1e2": resumeJson(55, "2024-06-15T10:00:00.000Z"), // in-progress, NEWEST
      "ep-s1e3": resumeJson(10, "2024-03-01T10:00:00.000Z"), // in-progress, middle
    };
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info(
      "[result] in-progress result =",
      result,
      "(expected ep-s1e2 as most recently updated)"
    );
    expect(result).toBe("ep-s1e2");
  });

  it("treats progressPct exactly 0 as not-in-progress (boundary)", () => {
    console.info("[phase] progressPct=0 boundary — should not count as in-progress");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": resumeJson(0), // exactly 0 → not in-progress
    };
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] progressPct=0 result =", result, "(expected ep-s1e1 as first unwatched)");
    // ep-s1e1 has progressPct=0 (not in-progress) → firstUnwatched finds it (pct<=0 → treated as unwatched)
    expect(result).toBe("ep-s1e1");
  });

  it("treats progressPct exactly 95 as finished, not in-progress (upper boundary)", () => {
    console.info("[phase] progressPct=95 boundary — should NOT be selected as in-progress");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": resumeJson(95), // >= 95 → finished, excluded from in-progress
    };
    // ep-s1e1 is finished (pct >= 95); ep-s1e2 has no resume → first unwatched = ep-s1e2
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] progressPct=95 result =", result, "(expected ep-s1e2 as first unwatched)");
    expect(result).toBe("ep-s1e2");
  });

  // -------------------------------------------------------------------------
  // Finished episodes (>= 95%) fall through to "first unwatched"
  // -------------------------------------------------------------------------

  it("skips fully-finished episodes (pct >= 95) when looking for first unwatched", () => {
    console.info("[phase] first episode finished (pct=100), second is unwatched");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": resumeJson(100), // fully finished
    };
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] first-unwatched after finished result =", result, "(expected ep-s1e2)");
    expect(result).toBe("ep-s1e2");
  });

  it("falls back to playable[0] when every episode is fully finished (pct >= 95)", () => {
    console.info("[phase] all episodes finished → fallback to playable[0] = ep-s1e1");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": resumeJson(98),
      "ep-s1e2": resumeJson(100),
    };
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] all-finished fallback result =", result, "(expected ep-s1e1 = playable[0])");
    expect(result).toBe("ep-s1e1");
  });

  // -------------------------------------------------------------------------
  // Robustness: invalid / malformed resume data must never throw
  // -------------------------------------------------------------------------

  it("tolerates invalid JSON in resume data — treats it as no resume", () => {
    console.info("[phase] invalid JSON resume — must not throw, treated as no-resume");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": "NOT VALID JSON{{{{",
    };
    let result: string | null;
    expect(() => {
      result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    }).not.toThrow();
    result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] invalid-JSON result =", result, "(expected ep-s1e1, treated as unwatched)");
    // ep-s1e1 bad JSON → treated as not in-progress and also as unwatched (catch returns true in firstUnwatched)
    expect(result).toBe("ep-s1e1");
  });

  it("tolerates a non-numeric progressPct — treated as not-in-progress", () => {
    console.info("[phase] progressPct is a string, not a number — must be tolerated");
    const show = makeTvShow([{ id: "ep-s1e1", s: 1, e: 1 }]);
    const badResume = JSON.stringify({ progressPct: "not-a-number", updatedAt: "2024-01-01T00:00:00.000Z" });
    expect(() => {
      pickAutoplayEpisodeId(show as any, () => badResume);
    }).not.toThrow();
    const result = pickAutoplayEpisodeId(show as any, () => badResume);
    console.info("[result] non-numeric progressPct result =", result, "(expected ep-s1e1, treated as unwatched)");
    // Number("not-a-number") = NaN → !isFinite → excluded from in-progress; firstUnwatched → ep-s1e1
    expect(result).toBe("ep-s1e1");
  });

  it("tolerates NaN progressPct — treated as not-in-progress", () => {
    console.info("[phase] progressPct serialised as null (parses as NaN via Number(null)=0, then <=0) — must be tolerated");
    const show = makeTvShow([{ id: "ep-s1e1", s: 1, e: 1 }]);
    const badResume = JSON.stringify({ progressPct: null, updatedAt: "2024-01-01T00:00:00.000Z" });
    expect(() => {
      pickAutoplayEpisodeId(show as any, () => badResume);
    }).not.toThrow();
    const result = pickAutoplayEpisodeId(show as any, () => badResume);
    console.info("[result] null progressPct result =", result);
    // Number(null) = 0 → pct <= 0 → not in-progress; firstUnwatched finds ep-s1e1 (pct<=0)
    expect(result).toBe("ep-s1e1");
  });

  it("tolerates a malformed updatedAt — falls back to updatedAtMs=0 instead of throwing", () => {
    console.info("[phase] malformed updatedAt string — Date.parse returns NaN, must fall back to 0");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": JSON.stringify({ progressPct: 40, updatedAt: "NOT_A_DATE" }),
      "ep-s1e2": JSON.stringify({ progressPct: 50, updatedAt: "2024-01-01T00:00:00.000Z" }),
    };
    let result: string | null;
    expect(() => {
      result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    }).not.toThrow();
    result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info(
      "[result] malformed-updatedAt result =",
      result,
      "(both in-progress; ep-s1e2 has valid date so wins; ep-s1e1 gets updatedAtMs=0)"
    );
    // ep-s1e1 gets updatedAtMs=0, ep-s1e2 gets a real timestamp → ep-s1e2 wins
    expect(result).toBe("ep-s1e2");
  });

  it("tolerates missing updatedAt field — treated as updatedAtMs=0", () => {
    console.info("[phase] no updatedAt field in resume JSON");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 },
      { id: "ep-s1e2", s: 1, e: 2 },
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e1": JSON.stringify({ progressPct: 40 }), // no updatedAt → updatedAtMs=0
      "ep-s1e2": JSON.stringify({ progressPct: 50, updatedAt: "2024-06-01T00:00:00.000Z" }),
    };
    expect(() => {
      pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    }).not.toThrow();
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] missing-updatedAt result =", result, "(ep-s1e2 wins with real timestamp)");
    expect(result).toBe("ep-s1e2");
  });

  // -------------------------------------------------------------------------
  // Mixed scenario: in-progress wins over unwatched and finished
  // -------------------------------------------------------------------------

  it("picks the in-progress episode even when earlier episodes are unwatched and later ones are finished", () => {
    console.info("[phase] mixed scenario: unwatched / in-progress / finished");
    const show = makeTvShow([
      { id: "ep-s1e1", s: 1, e: 1 }, // no resume (unwatched)
      { id: "ep-s1e2", s: 1, e: 2 }, // in-progress at 45%
      { id: "ep-s1e3", s: 1, e: 3 }, // finished at 97%
    ]);
    const resumeMap: Record<string, string> = {
      "ep-s1e2": resumeJson(45, "2024-09-01T00:00:00.000Z"),
      "ep-s1e3": resumeJson(97, "2024-10-01T00:00:00.000Z"),
    };
    const result = pickAutoplayEpisodeId(show as any, (id) => resumeMap[id]);
    console.info("[result] mixed scenario result =", result, "(expected ep-s1e2)");
    expect(result).toBe("ep-s1e2");
  });

  // -------------------------------------------------------------------------
  // getResumeRaw interface contract: caller-supplied map-backed lookup
  // -------------------------------------------------------------------------

  it("getResumeRaw is called with the episode id (not a storage key with a prefix)", () => {
    console.info("[phase] verifying getResumeRaw is called with bare episode IDs");
    const show = makeTvShow([{ id: "abc-123", s: 1, e: 1 }]);
    const calledWith: string[] = [];
    pickAutoplayEpisodeId(show as any, (id) => {
      calledWith.push(id);
      return undefined;
    });
    console.info("[result] getResumeRaw called with:", calledWith);
    expect(calledWith).toContain("abc-123");
    // Must NOT contain a prefixed key — storage-key shape is the caller's concern
    expect(calledWith.every((k) => !k.includes("episode_resume_v1:"))).toBe(true);
  });
});
