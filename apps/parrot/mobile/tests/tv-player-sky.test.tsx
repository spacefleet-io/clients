/**
 * @test-id PARROT-TV-PLAYER-SKY-001
 * @level unit
 * @req UX-SKY-01[parrot]
 * @why UX-SKY-01: nothing in the sky moves during playback. Parrot TV's shell sky stays on top while music plays (Now
 *   playing is a page over it), so it is paused by the player's state, as Parrot's phone sky is; before, a shooting star
 *   crossed Now playing on the Salon Google TV.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ state: null as { playing: boolean } | null }));

vi.mock("../src/state/usePlayerState", () => ({ usePlayerState: () => h.state }));
vi.mock("@space/mobile-shell/tv/TvSky", () => ({ TvSky: "TvSky" }));

import { TvPlayerSky } from "../src/tv/TvPlayerSky";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const skyProps = () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TvPlayerSky>{null}</TvPlayerSky>);
  });
  return renderer.root.find((node) => (node.type as unknown) === "TvSky").props as { active: boolean; paused: boolean };
};

describe("TvPlayerSky (UX-SKY-01)", () => {
  it("holds the shooting stars off while music plays", () => {
    h.state = { playing: true };
    expect(skyProps()).toMatchObject({ active: true, paused: true });
  });

  it("lets them fly when the player is paused or idle", () => {
    h.state = { playing: false };
    expect(skyProps()).toMatchObject({ active: true, paused: false });
    h.state = null;
    expect(skyProps()).toMatchObject({ active: true, paused: false });
  });
});
