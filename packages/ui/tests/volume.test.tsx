import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOLUME,
  effectiveVolume,
  parseVolumeState,
  setVolumeLevel,
  stepVolume,
  toggleMuted,
  volumeLevel,
  wheelSteps,
} from "../src/volume";
import { VolumeControl } from "../src/volume-control";

const labels = { volume: "Volume", mute: "Mute", unmute: "Unmute" };

// @req PAR-PLAY-05
describe("player volume logic (PAR-PLAY-05)", () => {
  it("steps 5 % per wheel notch or arrow key without float drift and stays in 0..1", () => {
    console.log("[volume] steps", stepVolume(0.1, 1), stepVolume(0.98, 1), stepVolume(0.02, -1));
    expect(stepVolume(0.1, 1)).toBe(0.15);
    expect(stepVolume(0.98, 1)).toBe(1);
    expect(stepVolume(0.02, -1)).toBe(0);
    expect(wheelSteps(-120)).toBe(1);
    expect(wheelSteps(53)).toBe(-1);
    expect(wheelSteps(0)).toBe(0);
  });

  it("shows the crossed speaker when muted or at 0, one wave below half, two from half up", () => {
    expect(volumeLevel({ volume: 0.8, muted: true })).toBe("muted");
    expect(volumeLevel({ volume: 0, muted: false })).toBe("muted");
    expect(volumeLevel({ volume: 0.3, muted: false })).toBe("low");
    expect(volumeLevel({ volume: 0.5, muted: false })).toBe("high");
  });

  it("mute keeps the level so unmute restores it; unmuting at 0 is never silent", () => {
    const muted = toggleMuted({ volume: 0.4, muted: false });
    expect(muted).toEqual({ volume: 0.4, muted: true });
    expect(toggleMuted(muted)).toEqual({ volume: 0.4, muted: false });
    expect(toggleMuted({ volume: 0, muted: false })).toEqual({ volume: 0.5, muted: false });
    expect(setVolumeLevel(muted, 0.6)).toEqual({ volume: 0.6, muted: false });
  });

  it("plays at the user level times the loudness-levelling gain, silent when muted, capped at full scale", () => {
    expect(effectiveVolume({ volume: 0.5, muted: false })).toBe(0.5);
    expect(effectiveVolume({ volume: 0.5, muted: false }, 0.5)).toBe(0.25);
    expect(effectiveVolume({ volume: 0.9, muted: false }, 2)).toBe(1);
    expect(effectiveVolume({ volume: 0.9, muted: true }, 1)).toBe(0);
  });

  it("reads a remembered level and falls back to full volume on anything malformed", () => {
    expect(parseVolumeState('{"volume":0.35,"muted":true}')).toEqual({ volume: 0.35, muted: true });
    expect(parseVolumeState('{"volume":7}')).toEqual({ volume: 1, muted: false });
    expect(parseVolumeState("not json")).toEqual(DEFAULT_VOLUME);
    expect(parseVolumeState(null)).toEqual(DEFAULT_VOLUME);
  });
});

describe("VolumeControl", () => {
  it("renders a labelled mute button and an accessible slider showing 0 while muted", () => {
    const html = renderToStaticMarkup(
      <VolumeControl volume={0.7} muted onVolumeChange={() => {}} onToggleMute={() => {}} labels={labels} testId="player-volume" />,
    );
    console.log("[volume] muted markup", html);
    expect(html).toContain('aria-label="Unmute"');
    expect(html).toContain('data-level="muted"');
    expect(html).toContain('aria-label="Volume"');
    expect(html).toContain('aria-valuetext="0%"');
    expect(html).toContain('data-testid="player-volume-slider"');
  });

  it("offers mute and shows the level when playing", () => {
    const html = renderToStaticMarkup(<VolumeControl volume={0.3} muted={false} onVolumeChange={() => {}} onToggleMute={() => {}} labels={labels} />);
    expect(html).toContain('aria-label="Mute"');
    expect(html).toContain('data-level="low"');
    expect(html).toContain('aria-valuetext="30%"');
  });
});
