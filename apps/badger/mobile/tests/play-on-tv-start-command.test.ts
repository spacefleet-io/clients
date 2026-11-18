// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The TV must start where the phone's own player would resume: the same progress rows, credits rule and resume
 *   thresholds (`RESUME_PROMPT_MIN_*`), else the TV restarts a half-watched title or resumes into the credits.
 */
import { describe, expect, it } from "vitest";
import { COMPLETED_PCT_THRESHOLD, RESUME_PROMPT_MIN_PCT, RESUME_PROMPT_MIN_SECONDS, type EpisodeResume } from "@space/shared/playbackResume";
import { buildStartCommand } from "../src/lib/playOnTv/startCommand";

type Details = Parameters<typeof buildStartCommand>[0]["details"];

const marker = (episodeId: string | null, startSeconds: number, endSeconds: number) =>
  ({ id: `mk-${episodeId}-${startSeconds}`, mediaId: "m1", episodeId, type: "credits", startSeconds, endSeconds }) as Details["skipMarkers"][number];

const movie = (progressPct: number, durationSeconds: number, skipMarkers: Details["skipMarkers"] = []): Details =>
  ({
    type: "movie",
    progressPct,
    files: [{ id: "f1", season: null, episode: null }],
    formats: [{ id: "fmt1", fileId: "f1", durationSeconds }],
    skipMarkers,
  }) as unknown as Details;

const show = (skipMarkers: Details["skipMarkers"] = []): Details =>
  ({
    type: "tv",
    progressPct: 40,
    files: [
      { id: "f11", season: 1, episode: 1 },
      { id: "f12", season: 1, episode: 2 },
    ],
    formats: [
      { id: "x11", fileId: "f11", durationSeconds: 999 },
      { id: "x12", fileId: "f12", durationSeconds: 2_000 },
    ],
    skipMarkers,
  }) as unknown as Details;

const EP2 = { id: "ep-2", seasonNumber: 1, episodeNumber: 2 };
const resume = (entry: Partial<EpisodeResume>): EpisodeResume => ({
  progressPct: 0,
  positionSeconds: null,
  durationSeconds: null,
  updatedAt: null,
  ...entry,
});

describe("buildStartCommand", () => {
  it("checks the thresholds this suite is written against", () => {
    console.info("[phase:thresholds]", JSON.stringify({ RESUME_PROMPT_MIN_PCT, RESUME_PROMPT_MIN_SECONDS, COMPLETED_PCT_THRESHOLD }));
    expect(RESUME_PROMPT_MIN_PCT).toBe(2);
    expect(RESUME_PROMPT_MIN_SECONDS).toBe(15);
    expect(COMPLETED_PCT_THRESHOLD).toBe(95);
  });

  it("resumes a movie at progressPct x the format's duration (floored)", () => {
    const command = buildStartCommand({ mediaId: "m1", details: movie(33.3, 6_001), episode: null, episodeResume: {} });
    console.info("[phase:movie]", JSON.stringify({ positionSeconds: command.positionSeconds, episode: command.episodeId }));
    expect(command).toEqual({ type: "start", mediaId: "m1", episodeId: null, positionSeconds: 1998, tracks: null });
  });

  it("starts a movie at 0 below the resume threshold", () => {
    // 1% of 1000 s = 10 s: under both RESUME_PROMPT_MIN_PCT (2 %) and RESUME_PROMPT_MIN_SECONDS (15 s).
    expect(buildStartCommand({ mediaId: "m1", details: movie(1, 1_000), episode: null, episodeResume: {} }).positionSeconds).toBe(0);
    // 1% of 2000 s = 20 s: over the seconds threshold but under the percentage -> both are needed, so 0.
    expect(buildStartCommand({ mediaId: "m1", details: movie(1, 2_000), episode: null, episodeResume: {} }).positionSeconds).toBe(0);
    // 3% of 2000 s = 60 s: over both thresholds -> resumes.
    expect(buildStartCommand({ mediaId: "m1", details: movie(3, 2_000), episode: null, episodeResume: {} }).positionSeconds).toBe(60);
    expect(buildStartCommand({ mediaId: "m1", details: movie(0, 2_000), episode: null, episodeResume: {} }).positionSeconds).toBe(0);
  });

  it("starts a movie at 0 past the credits or when completed", () => {
    const pastCredits = buildStartCommand({ mediaId: "m1", details: movie(90, 6_000, [marker(null, 5_000, 5_900)]), episode: null, episodeResume: {} });
    const beforeCredits = buildStartCommand({ mediaId: "m1", details: movie(50, 6_000, [marker(null, 5_000, 5_900)]), episode: null, episodeResume: {} });
    const completed = buildStartCommand({ mediaId: "m1", details: movie(96, 6_000), episode: null, episodeResume: {} });
    console.info("[phase:credits]", JSON.stringify({ past: pastCredits.positionSeconds, before: beforeCredits.positionSeconds, completed: completed.positionSeconds }));
    expect(pastCredits.positionSeconds).toBe(0);
    expect(beforeCredits.positionSeconds).toBe(3_000);
    expect(completed.positionSeconds).toBe(0);
  });

  it("starts at 0 when the duration is unknown", () => {
    const details = { ...movie(50, 0), formats: [] } as unknown as Details;
    expect(buildStartCommand({ mediaId: "m1", details, episode: null, episodeResume: {} }).positionSeconds).toBe(0);
  });

  it("resumes an episode at its own saved position", () => {
    const command = buildStartCommand({
      mediaId: "show-1",
      details: show(),
      episode: EP2,
      episodeResume: { "ep-2": resume({ progressPct: 10, positionSeconds: 321.7, durationSeconds: 3_000 }) },
    });
    console.info("[phase:episode]", JSON.stringify({ positionSeconds: command.positionSeconds, hasEpisode: command.episodeId !== null }));
    expect(command).toEqual({ type: "start", mediaId: "show-1", episodeId: "ep-2", positionSeconds: 321, tracks: null });
  });

  it("uses the episode's own file duration when the resume row has none", () => {
    const command = buildStartCommand({
      mediaId: "show-1",
      details: show(),
      episode: EP2,
      episodeResume: { "ep-2": resume({ progressPct: 50 }) },
    });
    expect(command.positionSeconds).toBe(1_000); // 50 % of S1E2's 2000 s, not S1E1's 999 s
  });

  it("starts an episode at 0 past its own credits, ignoring another episode's markers", () => {
    const entry = { "ep-2": resume({ progressPct: 60, positionSeconds: 1_200, durationSeconds: 2_000 }) };
    const own = buildStartCommand({ mediaId: "show-1", details: show([marker("ep-2", 1_100, 1_900)]), episode: EP2, episodeResume: entry });
    const other = buildStartCommand({ mediaId: "show-1", details: show([marker("ep-1", 1_100, 1_900)]), episode: EP2, episodeResume: entry });
    console.info("[phase:episode.credits]", JSON.stringify({ own: own.positionSeconds, other: other.positionSeconds }));
    expect(own.positionSeconds).toBe(0);
    expect(other.positionSeconds).toBe(1_200);
  });

  it("starts an episode without a resume row at 0, keeping the episode", () => {
    const command = buildStartCommand({ mediaId: "show-1", details: show(), episode: EP2, episodeResume: { "ep-9": resume({ progressPct: 50 }) } });
    expect(command).toEqual({ type: "start", mediaId: "show-1", episodeId: "ep-2", positionSeconds: 0, tracks: null });
  });

  it("never sends an episode id for a movie", () => {
    const command = buildStartCommand({ mediaId: "m1", details: movie(50, 1_000), episode: EP2, episodeResume: {} });
    console.info("[phase:movie.episode]", JSON.stringify({ episodeId: command.episodeId }));
    expect(command.episodeId).toBeNull();
  });
});
