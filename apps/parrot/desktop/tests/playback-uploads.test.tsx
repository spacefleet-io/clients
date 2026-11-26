// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PLAYBACK-UPLOADS-001
 * @level unit (the window's playing lease over a faked `window.parrot` bridge, fake timers)
 * @req PAR-UP-15
 * @why An import's uploads slow down or pause while a song plays here, as this computer's "Uploads while playing" setting
 *   says. Main hears that a song plays from the window, renewed within the gate's 15 s lease (a window that died stops
 *   holding the uploads), and that it stopped the moment it stops.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYBACK_RENEW_MS, usePlaybackUploadsLease } from "../src/renderer/src/playbackUploads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[parrot-playback-uploads]";

function Probe({ playing }: { playing: boolean }) {
  usePlaybackUploadsLease(playing);
  return null;
}

describe("PARROT-DESKTOP-PLAYBACK-UPLOADS-001 playing lease", () => {
  let root: Root | null = null;
  const playbackActive = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    playbackActive.mockReset();
    Object.assign(window, { parrot: { playbackActive } });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
  });

  it("says a song plays, renews it while it plays, and says it stopped", () => {
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(<Probe playing={false} />));
    act(() => root!.render(<Probe playing />));
    act(() => vi.advanceTimersByTime(PLAYBACK_RENEW_MS * 2 + 10));
    act(() => root!.render(<Probe playing={false} />));
    const calls = playbackActive.mock.calls.map(([active]) => active as boolean);
    console.info(SUITE, "calls", calls);
    expect(PLAYBACK_RENEW_MS).toBeLessThan(15_000);
    expect(calls.filter((active) => active)).toHaveLength(3);
    expect(calls.at(-1)).toBe(false);
    expect(calls.indexOf(true)).toBeGreaterThan(calls.indexOf(false));
  });
});
