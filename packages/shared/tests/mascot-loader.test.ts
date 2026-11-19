import { describe, expect, it } from "vitest";
import {
  MASCOT_LOADER_BOX,
  MASCOT_LOADER_SAMPLES,
  MASCOT_LOADERS,
  mascotLoaderKeyframes,
  mascotLoaderPhase,
  type MascotLoaderApp,
} from "../src/mascotLoader";

const APPS: MascotLoaderApp[] = ["badger", "parrot"];

// @req UX-WAIT-02
describe("loading-screen mascot motion", () => {
  it.each(APPS)("%s loops seamlessly: the pose just before the loop ends meets the first one", (app) => {
    const spec = MASCOT_LOADERS[app];
    const start = spec.pose(0);
    const end = spec.pose(1 - 1e-9);
    start.forEach((pose, layer) => {
      expect(end[layer]!.opacity).toBeCloseTo(pose.opacity, 4);
      // A note restarts at the headphones while invisible; only what shows must line up.
      if (pose.opacity < 1e-6) return;
      for (const key of ["x", "y", "rotate", "scaleX", "scaleY"] as const) {
        expect(end[layer]![key]).toBeCloseTo(pose[key], 4);
      }
    });
  });

  it.each(APPS)("%s keeps its 1.6 s loop and stays inside its box", (app) => {
    const spec = MASCOT_LOADERS[app];
    expect(spec.durationMs).toBe(1600);
    for (let i = 0; i < 100; i += 1) {
      for (const pose of spec.pose(i / 100)) {
        expect(pose.x).toBeGreaterThan(0);
        expect(pose.x).toBeLessThan(MASCOT_LOADER_BOX);
        expect(pose.y).toBeGreaterThan(0);
        expect(pose.y).toBeLessThan(MASCOT_LOADER_BOX);
        expect(pose.opacity).toBeGreaterThanOrEqual(0);
        expect(pose.opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("Badger only hovers: one layer, his picture, no film reel or stars (Chris, 2026-11-11)", () => {
    expect(MASCOT_LOADERS.badger.layers.map((layer) => layer.kind)).toEqual(["mascot"]);
  });

  it("Parrot nods with three music notes that fade in and out", () => {
    const layers = MASCOT_LOADERS.parrot.layers;
    expect(layers.map((layer) => layer.kind)).toEqual(["mascot", "prop", "prop", "prop"]);
    const opacities = Array.from({ length: 50 }, (_, i) => MASCOT_LOADERS.parrot.pose(i / 50)[1]!.opacity);
    expect(Math.min(...opacities)).toBeLessThan(0.1);
    expect(Math.max(...opacities)).toBe(1);
  });

  it.each(APPS)("%s keyframes close the loop: one track per layer, last sample equals the first", (app) => {
    const frames = mascotLoaderKeyframes(app);
    expect(frames).toHaveLength(MASCOT_LOADERS[app].layers.length);
    for (const track of frames) {
      expect(track).toHaveLength(MASCOT_LOADER_SAMPLES + 1);
      expect(track.at(-1)!.y).toBeCloseTo(track[0]!.y, 6);
    }
  });

  it.each(APPS)("%s takes up the loop where the clock stands, so a loader mounted mid-loop does not snap back", (app) => {
    const spec = MASCOT_LOADERS[app];
    expect(mascotLoaderPhase(app, 0)).toBe(0);
    expect(mascotLoaderPhase(app, 400)).toBeCloseTo(0.25, 9);
    expect(mascotLoaderPhase(app, 3 * spec.durationMs + 800)).toBeCloseTo(0.5, 9);
    // Two loaders, one mounted 0.3 loop later: once both run, they show the same pose at every instant.
    const first = mascotLoaderKeyframes(app, 0.1);
    const second = mascotLoaderKeyframes(app, 0.4);
    first.forEach((track, layer) => {
      expect(track[0]).toEqual(spec.pose(0.1)[layer]);
      expect(track.at(-1)).toEqual(track[0]);
      const later = MASCOT_LOADER_SAMPLES * 0.3;
      expect(second[layer]![0]!.y).toBeCloseTo(track[later]!.y, 6);
      expect(second[layer]![0]!.rotate).toBeCloseTo(track[later]!.rotate, 6);
    });
  });
});
