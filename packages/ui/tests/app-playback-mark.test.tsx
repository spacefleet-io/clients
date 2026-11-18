// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PLAYBACK_ATTRIBUTE, useAppPlaybackMark } from "../src/app-playback-mark";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const marked = () => document.documentElement.hasAttribute(APP_PLAYBACK_ATTRIBUTE);

const Mark = ({ active }: { active: boolean }) => {
  useAppPlaybackMark(active);
  return null;
};

describe("useAppPlaybackMark", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // @req UX-SKY-01[badger-desktop,parrot-web-player]
  it("keeps <html data-app-playback> while any of several overlapping players is active", () => {
    const render = (a: boolean, b: boolean) =>
      act(() =>
        root.render(
          <>
            <Mark active={a} />
            <Mark active={b} />
          </>,
        ),
      );
    const states: boolean[] = [];
    render(false, false);
    states.push(marked());
    render(true, false);
    states.push(marked());
    render(true, true);
    states.push(marked());
    render(false, true);
    states.push(marked());
    render(false, false);
    states.push(marked());
    render(true, true);
    act(() => root.render(null));
    states.push(marked());
    console.info(`[use-app-playback-mark:test] states=${JSON.stringify(states)}`);
    expect(states).toEqual([false, true, true, true, false, false]);
  });
});
