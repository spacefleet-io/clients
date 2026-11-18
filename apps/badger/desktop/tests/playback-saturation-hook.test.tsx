// @vitest-environment jsdom
/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 * @req PLAY-QUAL-07
 *
 * The renderer's view of the silo serving the playback in progress: the quality cap as the silo reports it, and the
 * refusals and stops counted since the hook mounted. The silo decides per account, so nothing depends on the plan.
 */
import React from "react";
import { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlaybackSaturation } from "../src/renderer/src/lib/usePlaybackSaturation";
import type { PlaybackSaturationState } from "../src/shared/playbackSaturation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Bridge = {
  getPlaybackSaturationState: () => Promise<PlaybackSaturationState>;
  onPlaybackSaturationChange: (cb: (s: PlaybackSaturationState) => void) => () => void;
};

// The preload bridge is typed in vite-env.d.ts; the test only installs the two calls under test.
const testWindow = window as unknown as { sf?: Bridge };

describe("usePlaybackSaturation (STOR-BW-07, STOR-BW-08)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: PlaybackSaturationState | null = null;

  const mount = async (bridge: Bridge | undefined) => {
    testWindow.sf = bridge;
    const Probe = () => {
      latest = usePlaybackSaturation();
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe />);
      await Promise.resolve();
    });
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container = null;
    latest = null;
    delete testWindow.sf;
  });

  const bridge = (initial: PlaybackSaturationState) => {
    let push: ((s: PlaybackSaturationState) => void) | null = null;
    const unsubscribe = vi.fn();
    const api: Bridge = {
      getPlaybackSaturationState: async () => initial,
      onPlaybackSaturationChange: (cb) => {
        push = cb;
        return unsubscribe;
      },
    };
    return { api, unsubscribe, push: (s: PlaybackSaturationState) => push?.(s) };
  };

  it("passes the silo's quality cap through", async () => {
    await mount(bridge({ qualityCap: "1080p", refusals: 0, stops: 0 }).api);
    expect(latest).toEqual({ qualityCap: "1080p", refusals: 0, stops: 0 });
  });

  it("counts refusals and stops from the first state heard, so an old event is not replayed", async () => {
    await mount(bridge({ qualityCap: "480p", refusals: 2, stops: 5 }).api);
    expect(latest).toEqual({ qualityCap: "480p", refusals: 0, stops: 0 });
  });

  it("follows the state pushed by the main process and unsubscribes on unmount", async () => {
    const b = bridge({ qualityCap: null, refusals: 1, stops: 1 });
    await mount(b.api);
    await act(async () => b.push({ qualityCap: "480p", refusals: 2, stops: 1 }));
    expect(latest).toEqual({ qualityCap: "480p", refusals: 1, stops: 0 });
    await act(async () => b.push({ qualityCap: "480p", refusals: 2, stops: 2 }));
    expect(latest).toEqual({ qualityCap: "480p", refusals: 1, stops: 1 });
    act(() => root?.unmount());
    root = null;
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the bridge is missing", async () => {
    await mount(undefined);
    expect(latest).toEqual({ qualityCap: null, refusals: 0, stops: 0 });
  });
});

describe("mpv playback engine wiring (PLAY-QUAL-07, STOR-BW-08)", () => {
  const SOURCE = readFileSync(
    path.resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"),
    "utf8",
  );

  it("steps Auto down to the cap, caps its ceiling, and tells the user", () => {
    expect(SOURCE).toContain("usePlaybackSaturation()");
    expect(SOURCE).toMatch(/capTarget\(/);
    expect(SOURCE).toMatch(/capCeilingRank\(/);
    expect(SOURCE).toContain("player.capToast480p");
    expect(SOURCE).toContain("player.capToast1080p");
  });

  it("stops by itself when a free viewer has no rung at or under the cap, and ends playback when the silo stops it", () => {
    expect(SOURCE).toMatch(/reportPlaybackStopped\?\.\(\)/);
    expect(SOURCE).toContain("player.errors.highTrafficStopped");
    expect(SOURCE).toContain("player.errors.highTrafficRefused");
  });

  it("has no pause or resume tied to the silo", () => {
    expect(SOURCE).not.toMatch(/freeFallback|freeFloor/);
    expect(SOURCE).not.toMatch(/saturation\.paused/);
  });
});
