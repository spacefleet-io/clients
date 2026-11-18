// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The TV player carries out the phone's commands through the same paths as its own remote (step seek with its
 *   toast, the controls' track pickers), refuses track picks it cannot honour, and describes itself back to the phone
 *   from the native snapshot, not from a guess.
 */
import { describe, expect, it } from "vitest";
import { applyRemoteCommand, buildTvState, type RemoteApplyDeps, type RemoteCommandForPlayer, type TvStateInput } from "./remotePlayerAdapter";

const setup = (withControls = true) => {
  const calls: string[] = [];
  const record = (call: string) => {
    calls.push(call);
    console.info("[phase:adapter.call]", call);
  };
  const deps: RemoteApplyDeps = {
    controls: withControls
      ? {
          stepSeek: (direction, seconds) => record(`stepSeek(${direction},${seconds})`),
          selectAudio: async (idx) => record(`selectAudio(${idx})`),
          selectSubtitle: async (idx) => record(`selectSubtitle(${idx})`),
          trackState: () => ({ audioIdx: 0, subtitleIdx: -1 }),
        }
      : null,
    player: {
      setPaused: async (paused) => record(`setPaused(${paused})`),
      seek: async (seconds, mode) => record(`seek(${seconds},${mode})`),
      seekRelative: async (seconds, mode) => record(`seekRelative(${seconds},${mode})`),
    },
    audioTrackCount: 2,
    subtitleTrackCount: 3,
    close: () => record("close"),
  };
  return { deps, calls };
};

const run = async (command: RemoteCommandForPlayer, withControls = true) => {
  const { deps, calls } = setup(withControls);
  const result = await applyRemoteCommand(command, deps);
  console.info("[phase:adapter.apply]", JSON.stringify({ command, withControls, result, calls }));
  return { result, calls };
};

describe("applyRemoteCommand", () => {
  it("pause and play go through setPaused", async () => {
    expect(await run({ type: "pause" })).toEqual({ result: null, calls: ["setPaused(true)"] });
    expect(await run({ type: "play" })).toEqual({ result: null, calls: ["setPaused(false)"] });
  });

  it("seekBy uses the controls' step seek (with its toast), else a native relative seek", async () => {
    expect(await run({ type: "seekBy", deltaSeconds: -10 })).toEqual({ result: null, calls: ["stepSeek(-1,10)"] });
    expect(await run({ type: "seekBy", deltaSeconds: 30 })).toEqual({ result: null, calls: ["stepSeek(1,30)"] });
    expect(await run({ type: "seekBy", deltaSeconds: 30 }, false)).toEqual({ result: null, calls: ["seekRelative(30,null)"] });
    expect(await run({ type: "seekBy", deltaSeconds: 0 })).toEqual({ result: null, calls: [] });
  });

  it("seekTo seeks to the absolute position", async () => {
    expect(await run({ type: "seekTo", positionSeconds: 1234 })).toEqual({ result: null, calls: ["seek(1234,absolute)"] });
  });

  it("track picks go through the controls' pickers within range", async () => {
    expect(await run({ type: "setAudio", idx: 1 })).toEqual({ result: null, calls: ["selectAudio(1)"] });
    expect(await run({ type: "setAudio", idx: 2 })).toEqual({ result: "no_such_track", calls: [] });
    expect(await run({ type: "setSubtitle", idx: -1 })).toEqual({ result: null, calls: ["selectSubtitle(-1)"] });
    expect(await run({ type: "setSubtitle", idx: 2 })).toEqual({ result: null, calls: ["selectSubtitle(2)"] });
    expect(await run({ type: "setSubtitle", idx: 3 })).toEqual({ result: "no_such_track", calls: [] });
  });

  it("track picks without controls are not_ready", async () => {
    expect(await run({ type: "setAudio", idx: 0 }, false)).toEqual({ result: "not_ready", calls: [] });
    expect(await run({ type: "setSubtitle", idx: 0 }, false)).toEqual({ result: "not_ready", calls: [] });
  });

  it("stop closes the player like Back", async () => {
    expect(await run({ type: "stop" })).toEqual({ result: null, calls: ["close"] });
  });
});

const input = (overrides: Partial<TvStateInput> = {}): TvStateInput => ({
  mediaId: "m1",
  episodeId: "e1",
  title: "Title",
  failed: false,
  snapshot: { position: 120.5, duration: 3_600, paused: false, voConfigured: true },
  fallbackDurationSeconds: 3_000,
  audioTracks: [{ label: " English ", language: "en" }, { label: null, language: " " }],
  subtitleTracks: [{ label: "", language: "fr" }],
  trackState: { audioIdx: 1, subtitleIdx: 0 },
  ...overrides,
});

describe("buildTvState", () => {
  it("describes a playing player from its snapshot", () => {
    const state = buildTvState(input());
    console.info("[phase:state.playing]", JSON.stringify({ phase: state.phase, pos: state.positionSeconds, dur: state.durationSeconds }));
    expect(state).toEqual({
      type: "state",
      phase: "playing",
      mediaId: "m1",
      episodeId: "e1",
      title: "Title",
      positionSeconds: 120.5,
      durationSeconds: 3_600,
      audioTracks: [
        { idx: 0, label: "English", language: "en" },
        { idx: 1, label: null, language: null },
      ],
      subtitleTracks: [{ idx: 0, label: null, language: "fr" }],
      audioIdx: 1,
      subtitleIdx: 0,
      error: null,
    });
  });

  it("derives the phase: failed, loading (no snapshot / no video yet), paused", () => {
    const phases = {
      failed: buildTvState(input({ failed: true })).phase,
      noSnapshot: buildTvState(input({ snapshot: null })).phase,
      noVideo: buildTvState(input({ snapshot: { position: 0, duration: 0, paused: false, voConfigured: false } })).phase,
      paused: buildTvState(input({ snapshot: { position: 5, duration: 10, paused: true, voConfigured: true } })).phase,
    };
    console.info("[phase:state.phases]", JSON.stringify(phases));
    expect(phases).toEqual({ failed: "failed", noSnapshot: "loading", noVideo: "loading", paused: "paused" });
  });

  it("falls back on the known duration, clamps the position and defaults the tracks", () => {
    const state = buildTvState(input({ snapshot: { position: -3, duration: 0, paused: false, voConfigured: true }, trackState: null }));
    expect(state).toMatchObject({ positionSeconds: 0, durationSeconds: 3_000, audioIdx: null, subtitleIdx: -1 });
    expect(buildTvState(input({ snapshot: null })).durationSeconds).toBe(3_000);
    expect(buildTvState(input({ trackState: { audioIdx: 5, subtitleIdx: -1 } })).audioIdx).toBeNull();
    expect(buildTvState(input({ trackState: { audioIdx: -1, subtitleIdx: -1 } })).audioIdx).toBeNull();
  });
});
