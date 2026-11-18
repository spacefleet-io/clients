/**
 * TV-SHELL-FOCUS-002 (TV-SHELL-FOCUS-001: Home opens on its first card). When the Main screen finishes appearing, UIKit runs
 * its own focus update and lands on the top tabs; the hook gives the focus back on `transitionEnd`. The two race: on the
 * Apple TV simulator (2026-10-23, after "Who's watching?") the hook's request landed first and UIKit's update 14 ms later,
 * so Home stayed on the Home tab. The hook therefore takes the focus back once more when the card loses it right after the
 * request (within SETTLE_MS, before any user could press a key), and leaves a later move (the user's) alone.
 * Rendered with react-test-renderer; react-native and the navigation are stand-ins.
 *
 * @bugfix @regression-proof
 * @req UX-TV-01[badger-tv]
 */
import React, { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";
import { SETTLE_MS, useFocusAfterScreenAppears } from "./useFocusAfterScreenAppears";

const nav = vi.hoisted(() => ({ listeners: [] as ((event: { data: { closing: boolean } }) => void)[] }));

vi.mock("react-native", async () => ({ ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    addListener: (_name: string, listener: (event: { data: { closing: boolean } }) => void) => {
      nav.listeners.push(listener);
      return () => nav.listeners.splice(nav.listeners.indexOf(listener), 1);
    },
  }),
}));

const requestTVFocus = vi.fn();
let onBlur: () => void = () => undefined;

const Card = ({ enabled }: { enabled: boolean }) => {
  const ref = useRef({ requestTVFocus } as never);
  onBlur = useFocusAfterScreenAppears(ref, enabled);
  return null;
};

const appear = () => act(() => nav.listeners.slice().forEach((listener) => listener({ data: { closing: false } })));

describe("useFocusAfterScreenAppears (TV-SHELL-FOCUS-002)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nav.listeners.length = 0;
    requestTVFocus.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("takes the focus back when UIKit's own focus update lands just after the request", () => {
    act(() => {
      create(<Card enabled />);
    });
    appear();
    console.info("[TV-SHELL-FOCUS-002] after transitionEnd: requests", requestTVFocus.mock.calls.length);
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(14);
    });
    act(() => onBlur());
    console.info("[TV-SHELL-FOCUS-002] after the blur 14 ms later: requests", requestTVFocus.mock.calls.length);
    expect(requestTVFocus).toHaveBeenCalledTimes(2);
    // Only once: a later blur is the user's move.
    act(() => onBlur());
    expect(requestTVFocus).toHaveBeenCalledTimes(2);
  });

  it("leaves a blur after the settle window alone (the user moved on)", () => {
    act(() => {
      create(<Card enabled />);
    });
    appear();
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS + 1);
    });
    act(() => onBlur());
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a card that does not hold the preferred focus", () => {
    act(() => {
      create(<Card enabled={false} />);
    });
    appear();
    act(() => onBlur());
    expect(requestTVFocus).not.toHaveBeenCalled();
  });
});
