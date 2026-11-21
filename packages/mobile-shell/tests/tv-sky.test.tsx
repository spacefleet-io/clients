/**
 * @test-id MOBILE-SHELL-TV-SKY-001
 * @level unit
 * @why UX-SKY-01: nothing in the sky moves during playback. Parrot TV's shell is always on top while music plays, so
 *   `TvSky` must take the app's own pause besides "another screen covers this one"; without it a shooting star crossed
 *   Now playing on the Salon Google TV.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  View: "View",
}));
vi.mock("../src/components", () => ({
  MobileAppBackdrop: "MobileAppBackdrop",
  SkyCoversProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  createSkyCoverRegistry: () => ({}),
  createUserInputSignal: () => ({}),
  useMobileSkyMode: () => "animated",
  useSkyRemoteInput: () => undefined,
}));

import { TvSky } from "../src/tv/TvSky";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const backdropPaused = (props: { active: boolean; paused?: boolean }) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TvSky {...props}>{null}</TvSky>);
  });
  return renderer.root.find((node) => (node.type as unknown) === "MobileAppBackdrop").props.paused as boolean;
};

describe("TvSky (UX-SKY-01)", () => {
  // @req UX-SKY-01[badger-tv]
  // @req UX-SKY-01[parrot]
  it("flies shooting stars only while on top and not paused by the app", () => {
    expect(backdropPaused({ active: true })).toBe(false);
    expect(backdropPaused({ active: false })).toBe(true);
    expect(backdropPaused({ active: true, paused: true })).toBe(true);
    expect(backdropPaused({ active: false, paused: false })).toBe(true);
  });
});
