import { describe, expect, it } from "vitest";
import {
  SKY_IDLE_MS,
  SKY_SHOOTING_TRAVEL_PX,
  STAR_SKY_CSS,
  createSkyMotionGate,
  createSkyShootingStars,
  createSkyStars,
  shootingOpacityAt,
  shootingStarAt,
  type SkyMotion,
} from "../src/starSky";

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

// @req UX-SKY-02
describe("star sky core: the website hero's numbers", () => {
  it("draws 150 stars of 0.6-2.2 px at 0.2-0.8 opacity twinkling every 2-6 s", () => {
    const stars = createSkyStars(seeded(7));
    console.log("first star", stars[0]);
    expect(stars).toHaveLength(150);
    for (const s of stars) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(100);
      expect(s.sizePx).toBeGreaterThanOrEqual(0.6);
      expect(s.sizePx).toBeLessThan(2.2);
      expect(s.opacity).toBeGreaterThanOrEqual(0.2);
      expect(s.opacity).toBeLessThan(0.8);
      expect(s.twinkleS).toBeGreaterThanOrEqual(2);
      expect(s.twinkleS).toBeLessThan(6);
      expect(s.delayS).toBeLessThan(4);
    }
  });

  it("flies 3 shooting stars looping every 2-4 s, first within 6 s", () => {
    const comets = createSkyShootingStars(seeded(9));
    expect(comets).toHaveLength(3);
    for (const c of comets) {
      expect(c.durationS).toBeGreaterThanOrEqual(2);
      expect(c.durationS).toBeLessThan(4);
      expect(c.delayS).toBeLessThan(6);
    }
  });

  it("fades in over the first 10%, is gone at 60%, like the hero's keyframes", () => {
    expect(shootingOpacityAt(0)).toBe(0);
    expect(shootingOpacityAt(0.05)).toBeCloseTo(0.5);
    expect(shootingOpacityAt(0.1)).toBe(1);
    expect(shootingOpacityAt(0.4)).toBeCloseTo(0.6);
    expect(shootingOpacityAt(0.5)).toBeCloseTo(0.3);
    expect(shootingOpacityAt(0.6)).toBe(0);
    expect(shootingOpacityAt(0.9)).toBe(0);
  });

  it("travels 1500 px a loop toward the lower left at 45 degrees", () => {
    const star = { top: 10, right: 10, durationS: 2, delayS: 1 };
    expect(shootingStarAt(star, 500).opacity).toBe(0);
    const half = shootingStarAt(star, 2_000);
    console.log("pose at half a loop", half);
    expect(half.dx).toBeCloseTo(-SKY_SHOOTING_TRAVEL_PX / 2 / Math.SQRT2);
    expect(half.dy).toBeCloseTo(SKY_SHOOTING_TRAVEL_PX / 2 / Math.SQRT2);
    // Loops: one duration later it is at the same place.
    expect(shootingStarAt(star, 4_000).dx).toBeCloseTo(half.dx);
  });

  it("keeps the hero's stylesheet byte for byte", () => {
    expect(STAR_SKY_CSS).toContain("@keyframes sf-star-twinkle");
    expect(STAR_SKY_CSS).toContain("50% { opacity: calc(var(--star-opacity) * 0.4); transform: scale(0.85); }");
    expect(STAR_SKY_CSS).toContain("0% { transform: rotate(315deg) translateX(0); opacity: 0; }");
    expect(STAR_SKY_CSS).toContain("10% { opacity: 1; }");
    expect(STAR_SKY_CSS).toContain("40% { opacity: 0.6; }");
    expect(STAR_SKY_CSS).toContain("60% { opacity: 0; }");
    expect(STAR_SKY_CSS).toContain("100% { transform: rotate(315deg) translateX(-1500px); opacity: 0; }");
    expect(STAR_SKY_CSS).toContain("width: 200px;");
    expect(STAR_SKY_CSS).toContain("linear-gradient(90deg, rgba(255, 255, 255, 0.9), transparent)");
  });
});

// @req UX-SKY-01
describe("the apps' motion gate", () => {
  const harness = () => {
    let t = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const seen: SkyMotion[] = [];
    const gate = createSkyMotionGate({
      now: () => t,
      setTimer: (fn, ms) => {
        timers.set(next, { at: t + ms, fn });
        return next++;
      },
      clearTimer: (id) => timers.delete(id as number),
      onChange: (m) => seen.push(m),
    });
    const advance = (ms: number) => {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    };
    return { gate, seen, advance, timers };
  };

  it("starts off, goes live once unblocked with no recent input", () => {
    const { gate, seen } = harness();
    expect(gate.current()).toBe("off");
    gate.setBlocked(false);
    console.log("motions", seen);
    expect(gate.current()).toBe("live");
  });

  it("holds still on input and moves again after 5 s of quiet", () => {
    const { gate, advance, timers } = harness();
    gate.setBlocked(false);
    gate.noteInput();
    expect(gate.current()).toBe("still");
    advance(SKY_IDLE_MS - 100);
    gate.noteInput(); // a pointermove keeps it still and arms no second timer
    expect(timers.size).toBe(1);
    advance(SKY_IDLE_MS - 1);
    expect(gate.current()).toBe("still");
    advance(1);
    expect(gate.current()).toBe("live");
  });

  it("a held touch keeps it still until released and quiet", () => {
    const { gate, advance } = harness();
    gate.setBlocked(false);
    gate.setInputHeld(true);
    advance(60_000);
    expect(gate.current()).toBe("still");
    gate.setInputHeld(false);
    advance(SKY_IDLE_MS);
    expect(gate.current()).toBe("live");
  });

  it("playback, hidden window or reduced motion turn it off at once", () => {
    const { gate, advance } = harness();
    gate.setBlocked(false);
    gate.setBlocked(true);
    expect(gate.current()).toBe("off");
    gate.noteInput();
    advance(60_000);
    expect(gate.current()).toBe("off");
    gate.dispose();
  });
});
