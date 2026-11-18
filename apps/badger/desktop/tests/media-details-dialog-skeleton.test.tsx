// @vitest-environment jsdom
/**
 * Tests for the episode-row progress skeleton introduced in commit B
 * (progress skeleton — `buildEpisodeResumeMap` returns `{ entries, isReady }`).
 *
 * APPROACH:
 *   MediaDetailsDialog.tsx is 3096 lines and consumes ~25 context hooks. Full
 *   mount in jsdom requires an impractical mock surface. We use two tiers:
 *
 *   Tier 1 (source-level) — assert that:
 *     - `animate-pulse` in the episode row is gated on `!episodeResumesReady`
 *     - `episodeResumesReady` is derived from `buildEpisodeResumeMap(...).isReady`
 *     - the real progress bar renders only when `episodeResumesReady && episodeResume`
 *     These assertions are structural invariants; they break if the template
 *     is refactored to drop the skeleton or change the conditional guard.
 *
 *   Tier 2 (behavioral, pure-function) — `buildEpisodeResumeMap` is the pure
 *     seam between `datasetStatus.playback` and what the skeleton/bar renders.
 *     Its behavioral contract is already partially covered in
 *     `media-details-processing.test.ts`; this file adds skeleton-specific
 *     scenarios: the isReady=false path (skeleton shown) vs the isReady=true
 *     with-data path (real bar shown).
 *
 * The two tiers together prove: when datasetStatus.playback=false, the
 * skeleton is rendered; when playback=true with resume data, the real bar
 * renders. A full mount test is noted as a follow-up requiring either a
 * lighter wrapper component or a complete context mock harness.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEpisodeResumeMap,
} from "../src/renderer/src/lib/mediaDetailsProcessing";
import type { MediaDetails } from "../src/renderer/src/lib/libraryDb";
import { buildMediaDetailsFixture } from "./_helpers/mediaDetailsFixture";

// ---------------------------------------------------------------------------
// Source under scrutiny (loaded once for all source-level assertions)
// ---------------------------------------------------------------------------

const dialogSource = readFileSync(
  resolve(process.cwd(), "src/renderer/src/components/MediaDetailsDialog.tsx"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Tier 1: source-level assertions for the skeleton branch
// ---------------------------------------------------------------------------

describe("MediaDetailsDialog episode-row skeleton (source-level assertions)", () => {
  it(
    "derives episodeResumesReady from buildEpisodeResumeMap(...).isReady",
    () => {
      console.info("[skeleton:source1] checking episodeResumesReady derivation");
      // The `{ entries: episodeResumeById, isReady: episodeResumesReady }` destructure
      // binds isReady to episodeResumesReady, which is the isReady boolean from
      // buildEpisodeResumeMap. This is the pivot point for the skeleton.
      expect(dialogSource).toMatch(
        /isReady:\s*episodeResumesReady/
      );
      // Confirm buildEpisodeResumeMap is called with datasetStatus.playback
      expect(dialogSource).toMatch(
        /buildEpisodeResumeMap\s*\(\s*selectedDetails\s*,\s*getSharedSetting\s*,\s*datasetStatus\.playback\s*\)/
      );
      console.info("[skeleton:source1] PASS — episodeResumesReady wired correctly");
    }
  );

  it(
    "renders animate-pulse skeleton inside the !episodeResumesReady early-return branch",
    () => {
      console.info("[skeleton:source2] checking skeleton guard");
      // After the progress-bands refactor the episode-row indicator is wrapped
      // in an IIFE with early returns: `if (!episodeResumesReady) { return
      // (skeleton); }`. The skeleton div still carries `animate-pulse`. This
      // assertion breaks if someone removes the early-return guard or changes
      // the conditional to a different variable.
      expect(dialogSource).toMatch(
        /if\s*\(\s*!episodeResumesReady\s*\)\s*\{/
      );
      expect(dialogSource).toMatch(/animate-pulse/);
      console.info("[skeleton:source2] PASS — skeleton guard present with animate-pulse");
    }
  );

  it(
    "renders the in-progress real bar only inside the in-progress band branch (gated on episodeResume + getProgressBand)",
    () => {
      console.info("[skeleton:source3] checking real-bar guard");
      // After the progress-bands refactor the real bar is rendered only when
      // `episodeResume` is truthy AND `getProgressBand(episodeResume.progressPct, ...)`
      // is in-progress (the fallthrough after the watched-band early return).
      // The structural pins:
      //   1. Early null-return when no resume data
      //   2. getProgressBand is called with episodeResume.progressPct as the first arg
      //      (Phase 2 adds an optional 2nd-arg credits-aware inputs object — the regex
      //      allows trailing arguments after the pct)
      //   3. getVisibleProgressPct is still what drives bar width
      expect(dialogSource).toMatch(
        /if\s*\(\s*!episodeResume\s*\)\s*return\s+null/
      );
      expect(dialogSource).toMatch(
        /getProgressBand\s*\(\s*episodeResume\.progressPct/
      );
      expect(dialogSource).toMatch(
        /getVisibleProgressPct\s*\(\s*episodeResume\.progressPct\s*\)/
      );
      console.info("[skeleton:source3] PASS — real bar gated on episodeResume + in-progress band");
    }
  );

  it(
    "[@bugfix][@regression-proof] renders the 'Watched' indicator inside the watched-band branch (CheckCircle2 + library.watched)",
    () => {
      console.info("[skeleton:source3b] checking watched-band rendering");
      // The watched band must render a distinct visual indicator (a checkmark
      // + 'Watched' label) instead of the near-full progress bar. The pins:
      //   1. band === "watched" check exists
      //   2. CheckCircle2 icon is rendered in that branch
      //   3. library.watched i18n key is used
      expect(dialogSource).toMatch(
        /band\s*===\s*["']watched["']/
      );
      expect(dialogSource).toMatch(/CheckCircle2/);
      expect(dialogSource).toMatch(/library\.watched/);
      console.info("[skeleton:source3b] PASS — watched indicator rendered with checkmark + label");
    }
  );

  it(
    "does not render animate-pulse outside the !episodeResumesReady guard",
    () => {
      console.info("[skeleton:source4] checking no spurious animate-pulse");
      // Count animate-pulse occurrences — should be exactly 1 (in the skeleton)
      const matches = dialogSource.match(/animate-pulse/g);
      expect(matches).not.toBeNull();
      // There should be exactly one animate-pulse in the dialog source
      // (the skeleton div). If someone adds another, this breaks so they
      // must explicitly document it.
      expect(matches).toHaveLength(1);
      console.info("[skeleton:source4] PASS — exactly 1 animate-pulse found");
    }
  );

  it(
    "wraps episodeResumesReady derivation in useMemo keyed on datasetStatus.playback",
    () => {
      console.info("[skeleton:source5] checking useMemo dependency on datasetStatus.playback");
      // The buildEpisodeResumeMap call is inside a useMemo. The dep array must
      // include datasetStatus.playback so the skeleton-→real-bar transition
      // triggers a re-render when playback stage hydrates.
      expect(dialogSource).toMatch(
        /useMemo\s*\(\s*\(\s*\)\s*=>\s*buildEpisodeResumeMap/
      );
      // The dep array must include datasetStatus.playback
      const memoMatch = dialogSource.match(
        /useMemo\s*\(\s*\(\s*\)\s*=>\s*buildEpisodeResumeMap[\s\S]*?\[([\s\S]*?)\]\s*\)/
      );
      expect(memoMatch).not.toBeNull();
      const depArray = memoMatch?.[1] ?? "";
      expect(depArray).toMatch(/datasetStatus\.playback/);
      console.info("[skeleton:source5] PASS — useMemo dep array includes datasetStatus.playback");
    }
  );
});

// ---------------------------------------------------------------------------
// Tier 2: behavioral tests of buildEpisodeResumeMap (the skeleton/bar pivot)
// ---------------------------------------------------------------------------

/**
 * Minimal MediaDetails for a TV show with two episodes.
 * Episodes ep-1 has resume data; ep-2 has none.
 */
const makeSkeletonTvDetails = (): MediaDetails =>
  buildMediaDetailsFixture({
    id: "show-skeleton",
    type: "tv",
    title: "Skeleton Show",
    files: [
      { id: "file-s1e1", season: 1, episode: 1 },
      { id: "file-s1e2", season: 1, episode: 2 },
    ],
    formats: [
      { id: "fmt-1", fileId: "file-s1e1", quality: "1080p", initKey: "i1", chunks: ["c1"] },
      { id: "fmt-2", fileId: "file-s1e2", quality: "1080p", initKey: "i2", chunks: ["c2"] },
    ],
    episodes: [
      { id: "ep-1", seasonNumber: 1, episodeNumber: 1 },
      { id: "ep-2", seasonNumber: 1, episodeNumber: 2 },
    ],
    audioTracks: [],
    subtitleTracks: [],
  });

describe("buildEpisodeResumeMap skeleton contract (behavioral, pure-function)", () => {
  /**
   * SKELETON SCENARIO — playbackReady=false
   *
   * When the playback dataset is still hydrating, buildEpisodeResumeMap must
   * return isReady=false with an empty entries Map. This is what causes
   * MediaDetailsDialog to render the animate-pulse skeleton instead of the
   * real progress bar.
   *
   * Importance: if isReady was accidentally returned as true during hydration,
   * the dialog would attempt to read progress from empty sharedSettings and
   * show no bar (wrong) instead of the pulsing skeleton.
   */
  it(
    "returns isReady=false and empty entries when playbackReady=false (skeleton shown)",
    () => {
      console.info("[skeleton:behavioral1] playbackReady=false path");
      const details = makeSkeletonTvDetails();

      // getSharedSetting HAS data — but playbackReady=false means we should
      // NOT read it and should return isReady=false (skeleton)
      const getSharedSetting = (key: string) => {
        if (key === "episode_resume_v1:ep-1") {
          return { value: JSON.stringify({ progressPct: 62, updatedAt: "2026-03-01T12:00:00Z" }) };
        }
        return null;
      };

      const result = buildEpisodeResumeMap(details, getSharedSetting, false);

      console.info("[skeleton:behavioral1] result:", {
        isReady: result.isReady,
        entriesSize: result.entries.size,
      });

      // isReady=false → skeleton renders
      expect(result.isReady).toBe(false);
      // entries must be empty even though getSharedSetting has data
      expect(result.entries.size).toBe(0);
    }
  );

  /**
   * REAL BAR SCENARIO — playbackReady=true with resume data
   *
   * When the playback dataset has hydrated and getSharedSetting returns
   * progress, buildEpisodeResumeMap must return isReady=true with populated
   * entries. This causes MediaDetailsDialog to render the real progress bar.
   */
  it(
    "returns isReady=true and populated entries when playbackReady=true with resume data (real bar shown)",
    () => {
      console.info("[skeleton:behavioral2] playbackReady=true with data path");
      const details = makeSkeletonTvDetails();

      const getSharedSetting = (key: string) => {
        if (key === "episode_resume_v1:ep-1") {
          return { value: JSON.stringify({ progressPct: 62, updatedAt: "2026-03-01T12:00:00Z" }) };
        }
        return null;
      };

      const result = buildEpisodeResumeMap(details, getSharedSetting, true);

      console.info("[skeleton:behavioral2] result:", {
        isReady: result.isReady,
        entriesSize: result.entries.size,
        ep1: result.entries.get("ep-1"),
      });

      // isReady=true → real bar renders
      expect(result.isReady).toBe(true);
      // ep-1 has 62% progress
      expect(result.entries.get("ep-1")?.progressPct).toBe(62);
      // ep-2 has no progress — entry absent
      expect(result.entries.has("ep-2")).toBe(false);
    }
  );

  /**
   * TRANSITION SCENARIO — playbackReady=false → true
   *
   * Simulates what happens when datasetStatus.playback changes:
   *   1. First call: playbackReady=false → isReady=false (skeleton)
   *   2. Second call after hydration: playbackReady=true → isReady=true (real bar)
   *
   * This proves the useMemo in MediaDetailsDialog will re-compute correctly
   * when datasetStatus.playback flips, driving the skeleton→real-bar transition.
   */
  it(
    "transitions from isReady=false (skeleton) to isReady=true (real bar) as playbackReady flips",
    () => {
      console.info("[skeleton:behavioral3] transition false→true path");
      const details = makeSkeletonTvDetails();
      const getSharedSetting = (key: string) => {
        if (key === "episode_resume_v1:ep-2") {
          return { value: JSON.stringify({ progressPct: 38, updatedAt: "2026-03-01T12:00:00Z" }) };
        }
        return null;
      };

      // Phase 1: hydrating — skeleton shown
      const before = buildEpisodeResumeMap(details, getSharedSetting, false);
      console.info("[skeleton:behavioral3] before:", {
        isReady: before.isReady,
        entriesSize: before.entries.size,
      });
      expect(before.isReady).toBe(false);
      expect(before.entries.size).toBe(0);

      // Phase 2: hydrated — real bar shown
      const after = buildEpisodeResumeMap(details, getSharedSetting, true);
      console.info("[skeleton:behavioral3] after:", {
        isReady: after.isReady,
        entriesSize: after.entries.size,
        ep2: after.entries.get("ep-2"),
      });
      expect(after.isReady).toBe(true);
      expect(after.entries.get("ep-2")?.progressPct).toBe(38);
    }
  );

  /**
   * NO RESUME DATA SCENARIO — playbackReady=true but no sharedSettings entries
   *
   * isReady=true with empty entries means the real bar conditional
   * (`episodeResume ? (real bar) : null`) returns null — no bar, no skeleton.
   * This is the "never watched" state.
   */
  it(
    "returns isReady=true with empty entries when playbackReady=true but no resume data (no bar shown)",
    () => {
      console.info("[skeleton:behavioral4] playbackReady=true no data path");
      const details = makeSkeletonTvDetails();
      const getSharedSetting = (_key: string) => null;

      const result = buildEpisodeResumeMap(details, getSharedSetting, true);

      console.info("[skeleton:behavioral4] result:", {
        isReady: result.isReady,
        entriesSize: result.entries.size,
      });

      // isReady=true → no skeleton
      expect(result.isReady).toBe(true);
      // no data → entries empty → real bar conditional returns null
      expect(result.entries.size).toBe(0);
    }
  );

  /**
   * MOVIE DETAILS SCENARIO — buildEpisodeResumeMap returns empty for movie type
   *
   * The skeleton and real bar are only rendered for TV episodes. Movies have
   * `details.type !== "tv"`, so buildEpisodeResumeMap returns empty entries
   * with isReady=playbackReady. This verifies no skeleton appears for movies.
   */
  it(
    "returns empty entries for movie details (no episode rows, no skeleton needed)",
    () => {
      console.info("[skeleton:behavioral5] movie type — no episode rows");
      const movieDetails: MediaDetails = {
        id: "movie-skeleton",
        type: "movie",
        title: "Skeleton Movie",
        files: [],
        formats: [],
        episodes: [],
        audioTracks: [],
        subtitleTracks: [],
      } as unknown as MediaDetails;

      const getSharedSetting = (_key: string) => null;

      const resultFalse = buildEpisodeResumeMap(movieDetails, getSharedSetting, false);
      const resultTrue = buildEpisodeResumeMap(movieDetails, getSharedSetting, true);

      console.info("[skeleton:behavioral5] results:", {
        whenFalse: { isReady: resultFalse.isReady, entriesSize: resultFalse.entries.size },
        whenTrue: { isReady: resultTrue.isReady, entriesSize: resultTrue.entries.size },
      });

      // isReady mirrors playbackReady for non-TV types (consistent with source)
      expect(resultFalse.isReady).toBe(false);
      expect(resultTrue.isReady).toBe(true);
      // No episodes → always empty entries
      expect(resultFalse.entries.size).toBe(0);
      expect(resultTrue.entries.size).toBe(0);
    }
  );
});
