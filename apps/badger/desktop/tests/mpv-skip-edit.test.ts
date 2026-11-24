// PLAY-SKIP-03/05: the renderer half of the player's "Was it right?" line and Change times panel.
import { describe, expect, it } from "vitest";
import type { SkipContribution } from "@space/metadata-client";
import type { MediaSkipMarker } from "../src/shared/libraryTypes";
import {
  applySkipEdit,
  parseSkipEditMessage,
  preselectSkipEdit,
  skipContributionFor,
  type SkipEditDeps,
} from "../src/renderer/src/lib/mpvSkipEdit";
import { buildMediaDetailsFixture } from "./_helpers/mediaDetailsFixture";

const marker = (episodeId: string, type: "intro" | "credits", startSeconds: number, endSeconds: number, source = "detected"): MediaSkipMarker => ({
  id: `${episodeId}-${type}`,
  mediaId: "show",
  episodeId,
  type,
  startSeconds,
  endSeconds,
  source,
  confidence: null,
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
});

// Season 2, four episodes; the intro's shared audio sits at a different place in each (cold opens differ).
const RAW = { e1: 60, e2: 90, e3: 45, e4: 120 } as const;
const buildShow = () => {
  const media = buildMediaDetailsFixture({
    id: "show",
    type: "tv",
    title: "Parks and Recreation",
    files: (["e1", "e2", "e3", "e4"] as const).map((id, index) => ({ id: `f-${id}`, season: 2, episode: index + 1 })),
    formats: (["e1", "e2", "e3", "e4"] as const).map((id) => ({
      id: `fmt-${id}`,
      fileId: `f-${id}`,
      quality: "1080p",
      initKey: null,
      chunks: [],
      durationSeconds: 1290,
    })),
    episodes: (["e1", "e2", "e3", "e4"] as const).map((id, index) => ({ id, seasonNumber: 2, episodeNumber: index + 1 })),
    audioTracks: [],
    subtitleTracks: [],
    skipMarkers: (["e1", "e2", "e3", "e4"] as const).flatMap((id) => [
      marker(id, "intro", RAW[id] + 2, RAW[id] + 30),
      marker(id, "credits", 1250, 1290),
    ]),
  });
  return { ...media, catalogId: 8592 };
};

const makeDeps = (media = buildShow()) => {
  const analysis: Array<{ episodeId: string | null; kind: string; payload: Record<string, unknown> }> = (
    ["e1", "e2", "e3", "e4"] as const
  ).map((id) => ({
    episodeId: id,
    kind: "skip-match-v1",
    payload: { version: 1, intro: { rawStart: RAW[id], rawEnd: RAW[id] + 30 }, credits: null },
  }));
  const writes: Array<{ episodeId: string | null; markers: Array<{ type: string; startSeconds: number; endSeconds: number; source: string }> }> = [];
  const contributions: SkipContribution[] = [];
  const deps: SkipEditDeps = {
    media,
    episodeId: "e2",
    listSkipAnalysis: async (_mediaId, kind) => analysis.filter((row) => !kind || row.kind === kind),
    upsertSkipAnalysis: async (_mediaId, episodeId, kind, payload) => {
      const index = analysis.findIndex((row) => row.episodeId === episodeId && row.kind === kind);
      if (index >= 0) analysis.splice(index, 1);
      analysis.push({ episodeId, kind, payload });
    },
    replaceSkipMarkers: async (_mediaId, episodeId, markers) => {
      writes.push({ episodeId, markers });
    },
    queueSkipContribution: (contribution) => contributions.push(contribution),
    log: (message, data) => console.info(`[sf-skip] test ${message}`, JSON.stringify(data ?? {})),
  };
  return { deps, analysis, writes, contributions };
};

const scriptMessage = (args: string[]) => ({ type: "script_message" as const, name: "sf-skip-edit", args });

// @req PLAY-SKIP-03[badger-desktop] PLAY-SKIP-05[badger-desktop]
describe("[sf-skip] mpv skip edit (PLAY-SKIP-03/05)", () => {
  it("parses sf.lua's messages and refuses anything else", () => {
    expect(parseSkipEditMessage(scriptMessage(["verdict", "intro", "92", "120", "1290.5"]))).toEqual({
      action: "verdict",
      kind: "intro",
      startSeconds: 92,
      endSeconds: 120,
      durationSeconds: 1290.5,
    });
    expect(parseSkipEditMessage(scriptMessage(["preselect", "credits", "1250", "1290"]))).toEqual({
      action: "preselect",
      kind: "credits",
      startSeconds: 1250,
      endSeconds: 1290,
    });
    expect(parseSkipEditMessage(scriptMessage(["save", "intro", "90", "121", "season", "1290"]))).toMatchObject({
      action: "save",
      scope: "season",
    });
    expect(parseSkipEditMessage(scriptMessage(["save", "intro", "90", "121", "everywhere", "1290"]))).toBeNull();
    expect(parseSkipEditMessage(scriptMessage(["save", "intro", "121", "90", "episode", "1290"]))).toBeNull();
    expect(parseSkipEditMessage(scriptMessage(["verdict", "recap", "1", "2", "3"]))).toBeNull();
    expect(parseSkipEditMessage({ type: "script_message", name: "sf-subtitle-fetch", args: ["open"] })).toBeNull();
    expect(parseSkipEditMessage({ type: "exit" })).toBeNull();
  });

  it("preselects This season for a small fix and Only this episode for a far one", async () => {
    const { deps } = makeDeps();
    expect(await preselectSkipEdit({ action: "preselect", kind: "intro", startSeconds: RAW.e2 + 1, endSeconds: RAW.e2 + 31 }, deps)).toEqual({
      kind: "preselect",
      scope: "season",
    });
    expect(await preselectSkipEdit({ action: "preselect", kind: "intro", startSeconds: RAW.e2 + 2, endSeconds: RAW.e2 + 60 }, deps)).toEqual({
      kind: "preselect",
      scope: "episode",
    });
  });

  it("a season save moves the intro of every matched episode and keeps their credits", async () => {
    const { deps, analysis, writes, contributions } = makeDeps();
    const answer = await applySkipEdit(
      { action: "save", kind: "intro", startSeconds: RAW.e2, endSeconds: RAW.e2 + 31, scope: "season", durationSeconds: 1290 },
      deps
    );
    expect(answer).toEqual({ kind: "saved", scope: "season" });
    expect(writes.map((write) => write.episodeId).sort()).toEqual(["e1", "e2", "e3", "e4"]);
    for (const write of writes) {
      const raw = RAW[write.episodeId as keyof typeof RAW];
      expect(write.markers).toContainEqual(expect.objectContaining({ type: "intro", startSeconds: raw, endSeconds: raw + 31, source: "user" }));
      expect(write.markers).toContainEqual(expect.objectContaining({ type: "credits", startSeconds: 1250, endSeconds: 1290, source: "detected" }));
    }
    const fix = analysis.find((row) => row.episodeId === null && row.kind === "skip-fix-v1");
    expect(fix?.payload).toEqual({ version: 1, seasons: { "2": { intro: { startOffset: 0, endOffset: 1 } } }, episodeOnly: {} });
    expect(contributions).toEqual([
      { id: 8592, season: 2, episode: 2, durationMs: 1290000, kind: "intro", startMs: 90000, endMs: 121000, verdict: "changed" },
    ]);
  });

  it("an episode-only save touches that episode alone and keeps later season fixes off it", async () => {
    const { deps, analysis, writes } = makeDeps();
    const answer = await applySkipEdit(
      { action: "save", kind: "intro", startSeconds: 95, endSeconds: 150, scope: "episode", durationSeconds: 1290 },
      deps
    );
    expect(answer).toEqual({ kind: "saved", scope: "episode" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.episodeId).toBe("e2");
    const fix = analysis.find((row) => row.episodeId === null && row.kind === "skip-fix-v1");
    expect(fix?.payload).toEqual({ version: 1, seasons: {}, episodeOnly: { e2: { intro: true } } });

    // A later season save from e1 leaves e2 alone.
    writes.length = 0;
    await applySkipEdit(
      { action: "save", kind: "intro", startSeconds: RAW.e1, endSeconds: RAW.e1 + 30, scope: "season", durationSeconds: 1290 },
      { ...deps, episodeId: "e1" }
    );
    expect(writes.map((write) => write.episodeId).sort()).toEqual(["e1", "e3", "e4"]);
  });

  it("Yes reports the skipped times as confirmed and stores nothing", async () => {
    const { deps, writes, contributions } = makeDeps();
    const answer = await applySkipEdit(
      { action: "verdict", kind: "intro", startSeconds: 92, endSeconds: 120, durationSeconds: 1290.4 },
      deps
    );
    expect(answer).toEqual({ kind: "saved", scope: "episode" });
    expect(writes).toEqual([]);
    expect(contributions).toEqual([
      { id: 8592, season: 2, episode: 2, durationMs: 1290400, kind: "intro", startMs: 92000, endMs: 120000, verdict: "confirmed" },
    ]);
  });

  it("the metadata service's or the user's own times are never reported: Yes and a change stay in each user's vault (META-SKIP-05)", async () => {
    const media = buildShow();
    const fromService = {
      ...media,
      skipMarkers: media.skipMarkers.map((entry) => (entry.episodeId === "e2" && entry.type === "intro" ? { ...entry, source: "metadata" } : entry)),
    };
    const { deps, writes, contributions } = makeDeps(fromService);
    await applySkipEdit({ action: "verdict", kind: "intro", startSeconds: 92, endSeconds: 120, durationSeconds: 1290.4 }, deps);
    await applySkipEdit(
      { action: "save", kind: "intro", startSeconds: 93, endSeconds: 121, durationSeconds: 1290.4, scope: "episode" },
      deps
    );
    console.info("[sf-skip] test private", JSON.stringify({ writes: writes.length, contributions }));
    expect(writes.length).toBe(1);
    expect(contributions).toEqual([]);
    // A fix of a detected time is reported as changed.
    const detected = makeDeps();
    await applySkipEdit(
      { action: "save", kind: "intro", startSeconds: 93, endSeconds: 121, durationSeconds: 1290.4, scope: "episode" },
      detected.deps
    );
    expect(detected.contributions).toMatchObject([{ kind: "intro", startMs: 93000, verdict: "changed" }]);
  });

  it("no report without a catalog id, and credits end no later than the file", () => {
    const media = buildShow();
    expect(skipContributionFor({ ...media, catalogId: null }, "e2", { kind: "intro", startSeconds: 1, endSeconds: 30, durationSeconds: 1290 }, "confirmed")).toBeNull();
    expect(
      skipContributionFor(media, "e2", { kind: "credits", startSeconds: 1250, endSeconds: 1300, durationSeconds: 1290 }, "changed")
    ).toMatchObject({ startMs: 1250000, endMs: 1290000 });
  });
});
