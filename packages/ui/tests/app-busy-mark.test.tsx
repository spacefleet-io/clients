// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_BUSY_ATTRIBUTE, useAppBusyMark } from "../src/app-busy-mark";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const marked = () => document.documentElement.hasAttribute(APP_BUSY_ATTRIBUTE);

const Mark = ({ active }: { active: boolean }) => {
  useAppBusyMark(active);
  return null;
};

// @req UX-SKY-01
describe("[@bugfix #2461][@regression-proof] useAppBusyMark", () => {
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
  });

  it("marks <html data-app-busy> while any mark is active, until the last one ends", () => {
    const states: Record<string, boolean> = {};
    act(() => root.render(<Mark active={false} />));
    states.idle = marked();
    act(() =>
      root.render(
        <>
          <Mark active />
          <Mark active />
        </>,
      ),
    );
    states.two = marked();
    act(() =>
      root.render(
        <>
          <Mark active />
          <Mark active={false} />
        </>,
      ),
    );
    states.one = marked();
    act(() => root.render(<Mark active={false} />));
    states.none = marked();
    console.info(`[use-app-busy-mark:test] states=${JSON.stringify(states)}`);
    expect(states).toEqual({ idle: false, two: true, one: true, none: false });
  });
});
