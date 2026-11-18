// @vitest-environment jsdom
// @bugfix UX-HOME-01 @regression-proof: playing from a Home poster then leaving Home (another page, Back) unmounted the
// inline player with mpv still open — an orphan mpv window kept playing over the app with nothing left to close it,
// and its progress showed up as a "Resume" the user never asked for. Leaving the page now stops mpv.

import React, { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useStopPlaybackOnUnmount } from "../src/renderer/src/lib/useStopPlaybackOnUnmount";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const log = (...args: unknown[]) => console.log("[stop-playback-on-unmount]", ...args);

const Host = ({ playing }: { playing: boolean }) => {
  useStopPlaybackOnUnmount(playing);
  return null;
};

let root: Root | null = null;
let stopExternalMpv: Mock<() => Promise<void>>;

const render = (playing: boolean, strict = false) => {
  const el = <Host playing={playing} />;
  act(() => root!.render(strict ? <StrictMode>{el}</StrictMode> : el));
};

beforeEach(() => {
  stopExternalMpv = vi.fn(() => Promise.resolve());
  Object.assign(window, { sf: { stopExternalMpv } });
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  Reflect.deleteProperty(window, "sf");
});

describe("useStopPlaybackOnUnmount", () => {
  it("stops mpv when the hosting page unmounts while a playback is open", () => {
    render(false);
    render(true);
    log("playing; unmounting the host page");
    act(() => root!.unmount());
    log("stopExternalMpv calls:", stopExternalMpv.mock.calls.length);
    expect(stopExternalMpv).toHaveBeenCalledTimes(1);
  });

  it("leaves mpv alone when the page unmounts with no playback open", () => {
    render(true);
    render(false);
    act(() => root!.unmount());
    log("stopExternalMpv calls:", stopExternalMpv.mock.calls.length);
    expect(stopExternalMpv).not.toHaveBeenCalled();
  });

  it("does not stop anything on StrictMode's mount-time remount", () => {
    render(false, true);
    log("stopExternalMpv calls after StrictMode mount:", stopExternalMpv.mock.calls.length);
    expect(stopExternalMpv).not.toHaveBeenCalled();
    act(() => root!.unmount());
  });
});
