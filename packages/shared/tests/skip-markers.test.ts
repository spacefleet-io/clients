import { describe, expect, it } from "vitest";
import {
  SKIP_SOURCE_DETECTED,
  SKIP_SOURCE_USER,
  mergeSkipMarkersByPriority,
  planSkipFix,
  preselectSkipFixScope,
  readSkipFixPayload,
  readSkipMatchPayload,
  type SkipFixEpisode,
} from "../src/skipMarkers";

const log = (label: string, value: unknown) => console.log(`[skip-markers.test] ${label}`, JSON.stringify(value));

// Season 2 of a show: the theme (20 s of shared audio) sits at a different time in each episode, and the skip in
// use is the detected one (shared audio, start padded by 2 s).
const season = (): SkipFixEpisode[] =>
  [
    { episodeId: "s2e1", at: 69.35 },
    { episodeId: "s2e2", at: 103.78 },
    { episodeId: "s2e3", at: 62.54 },
    { episodeId: "s2e4", at: 91.39 },
  ].map(({ episodeId, at }) => ({
    episodeId,
    season: 2,
    match: { rawStart: at, rawEnd: at + 20.3 },
    current: { startSeconds: at + 2, endSeconds: at + 20.3 },
    durationSeconds: 1300,
  }));

// @req PLAY-SKIP-08[badger-desktop]
describe("mergeSkipMarkersByPriority", () => {
  it("the user's times stay; the metadata service's replace detection, never the reverse (Chris 2026-11-24)", () => {
    const existing = [
      { type: "intro" as const, startSeconds: 10, endSeconds: 40, source: SKIP_SOURCE_USER },
      { type: "credits" as const, startSeconds: 1200, endSeconds: 1290, source: "metadata" },
    ];
    const incoming = [
      { type: "intro" as const, startSeconds: 12, endSeconds: 38, source: SKIP_SOURCE_DETECTED },
      { type: "credits" as const, startSeconds: 1210, endSeconds: 1290, source: SKIP_SOURCE_DETECTED },
    ];
    const merged = mergeSkipMarkersByPriority(existing, incoming);
    log("merged", merged);
    expect(merged).toEqual([
      { type: "intro", startSeconds: 10, endSeconds: 40, source: "user" },
      { type: "credits", startSeconds: 1200, endSeconds: 1290, source: "metadata" },
    ]);
    const service = mergeSkipMarkersByPriority(
      [{ type: "credits" as const, startSeconds: 1210, endSeconds: 1290, source: SKIP_SOURCE_DETECTED }],
      [{ type: "credits", startSeconds: 1000, endSeconds: 1290, source: "metadata" }]
    );
    log("after service fetch", service);
    expect(service).toEqual([{ type: "credits", startSeconds: 1000, endSeconds: 1290, source: "metadata" }]);
    expect(mergeSkipMarkersByPriority(merged, [{ type: "intro", startSeconds: 0, endSeconds: 30, source: "metadata" }])).toEqual(merged);
  });

  it("a new user fix replaces the previous one", () => {
    const merged = mergeSkipMarkersByPriority(
      [{ type: "intro" as const, startSeconds: 10, endSeconds: 40, source: SKIP_SOURCE_USER }],
      [{ type: "intro" as const, startSeconds: 11, endSeconds: 41, source: SKIP_SOURCE_USER }]
    );
    expect(merged).toEqual([{ type: "intro", startSeconds: 11, endSeconds: 41, source: "user" }]);
  });
});

// @req PLAY-SKIP-05[badger-desktop]
describe("skip fix carry-over", () => {
  it("a season fix keeps its offsets from the shared audio in every matched episode", () => {
    const episodes = season();
    const target = episodes[0]!;
    // The user ends the intro 3 s later and starts it 1 s earlier than the detected skip.
    const fix = { startSeconds: 69.35 + 1, endSeconds: 69.35 + 23.3 };
    const scope = preselectSkipFixScope(target, fix, episodes);
    const plan = planSkipFix({ target, fix, scope, episodes });
    log("scope", scope);
    log("plan", plan);
    expect(scope).toBe("season");
    expect(plan.seasonOffsets).toEqual({ startOffset: expect.closeTo(1, 6), endOffset: expect.closeTo(3, 6) });
    expect(plan.writes.map((w) => w.episodeId)).toEqual(["s2e1", "s2e2", "s2e3", "s2e4"]);
    expect(plan.writes[1]).toEqual({ episodeId: "s2e2", startSeconds: 104.78, endSeconds: 127.08 });
    expect(plan.writes[3]).toEqual({ episodeId: "s2e4", startSeconds: 92.39, endSeconds: 114.69 });
  });

  it("preselects Only this episode when the fix lands more than 10 s from the other episodes", () => {
    const episodes = season();
    const target = episodes[2]!;
    // A cold open runs into the theme in this episode only: the skip should end 25 s later here.
    const fix = { startSeconds: 64.54, endSeconds: 62.54 + 20.3 + 25 };
    const scope = preselectSkipFixScope(target, fix, episodes);
    log("scope far fix", { fix, scope });
    expect(scope).toBe("episode");
    const plan = planSkipFix({ target, fix, scope, episodes });
    expect(plan).toEqual({ writes: [{ episodeId: "s2e3", ...fix }], seasonOffsets: null });
  });

  it("a fix within 10 s of the others preselects This season", () => {
    const episodes = season();
    const fix = { startSeconds: 103.78 + 2 + 9, endSeconds: 103.78 + 20.3 };
    expect(preselectSkipFixScope(episodes[1]!, fix, episodes)).toBe("season");
  });

  it("leaves episodes fixed for themselves alone, and other seasons too", () => {
    const episodes = [
      ...season(),
      { episodeId: "s3e1", season: 3, match: { rawStart: 50, rawEnd: 70 }, current: null, durationSeconds: 1300 },
    ];
    const plan = planSkipFix({
      target: episodes[0]!,
      fix: { startSeconds: 70, endSeconds: 90 },
      scope: "season",
      episodes,
      episodeOnly: new Set(["s2e3"]),
    });
    log("plan with pinned", plan.writes);
    expect(plan.writes.map((w) => w.episodeId)).toEqual(["s2e1", "s2e2", "s2e4"]);
  });

  it("without a match the fix follows the times the other episodes use now", () => {
    const episodes: SkipFixEpisode[] = [
      { episodeId: "a", season: 1, match: null, current: { startSeconds: 30, endSeconds: 60 } },
      { episodeId: "b", season: 1, match: null, current: { startSeconds: 80, endSeconds: 110 } },
      { episodeId: "c", season: 1, match: null, current: null },
    ];
    const fix = { startSeconds: 30, endSeconds: 62 };
    expect(preselectSkipFixScope(episodes[0]!, fix, episodes)).toBe("season");
    const plan = planSkipFix({ target: episodes[0]!, fix, scope: "season", episodes });
    log("plan without match", plan);
    expect(plan.writes).toEqual([
      { episodeId: "a", startSeconds: 30, endSeconds: 62 },
      { episodeId: "b", startSeconds: 80, endSeconds: 112 },
    ]);
    expect(plan.seasonOffsets).toBeNull();
  });

  it("an episode without any times can only be fixed for itself", () => {
    const episodes: SkipFixEpisode[] = [
      { episodeId: "a", season: 1, match: null, current: null },
      { episodeId: "b", season: 1, match: null, current: { startSeconds: 80, endSeconds: 110 } },
    ];
    expect(preselectSkipFixScope(episodes[0]!, { startSeconds: 0, endSeconds: 40 }, episodes)).toBe("episode");
  });
});

describe("stored payloads", () => {
  it("reads only version-1 payloads", () => {
    expect(readSkipMatchPayload({ version: 1, intro: { rawStart: 1, rawEnd: 21 }, credits: "x" })).toEqual({
      version: 1,
      intro: { rawStart: 1, rawEnd: 21 },
      credits: null,
    });
    expect(readSkipMatchPayload({ version: 2 })).toBeNull();
    expect(readSkipFixPayload(null)).toEqual({ version: 1, seasons: {}, episodeOnly: {} });
    const fix = { version: 1, seasons: { "2": { intro: { startOffset: 1, endOffset: 3 } } }, episodeOnly: { e: { intro: true } } };
    expect(readSkipFixPayload(fix)).toEqual(fix);
  });
});
