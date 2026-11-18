import { describe, expect, it } from "vitest";
import { NEBULA_FADE_AT, NEBULA_REFERENCE_WINDOW, SKY_NEBULAS, mobileNebulaSpots, nebulaCss } from "../src/skyNebula";

// @req UX-SKY-03
describe("sky nebulas", () => {
  it("Parrot's nebula is the approved green glows, 2.5 times as strong (Chris, 2026-11-10)", () => {
    const css = nebulaCss("parrot");
    console.info("[sky-nebula] parrot", css);
    expect(css).toBe(
      "radial-gradient(60rem 30rem at 12% -8%, hsl(150 75% 45% / 0.35), transparent 60%), " +
        "radial-gradient(50rem 28rem at 92% 4%, hsl(172 65% 45% / 0.25), transparent 60%), " +
        "radial-gradient(40rem 30rem at 60% 110%, hsl(262 70% 62% / 0.2), transparent 60%)",
    );
  });

  it("Badger's nebula is the same glows in Badger's accent yellow, at the same strength and softness", () => {
    const parrot = SKY_NEBULAS.parrot;
    const badger = SKY_NEBULAS.badger;
    console.info("[sky-nebula] badger", nebulaCss("badger"));
    expect(badger[0]).toMatchObject({ hue: 33, sat: 100, light: 67 });
    expect(badger.map(({ x, y, rxRem, ryRem, opacity }) => ({ x, y, rxRem, ryRem, opacity }))).toEqual(
      parrot.map(({ x, y, rxRem, ryRem, opacity }) => ({ x, y, rxRem, ryRem, opacity })),
    );
  });

  it("the phone and TV get the same glows, sized as shares of the screen like the 1280 × 800 desktop window", () => {
    const spots = mobileNebulaSpots("badger");
    console.info("[sky-nebula] mobile badger", spots);
    expect(spots[0]).toEqual({ x: 0.12, y: -0.08, rx: 0.75, ry: 0.6, color: "hsl(33, 100%, 67%)", opacity: 0.35 });
    expect(spots).toHaveLength(3);
  });

  it("each glow reaches as far down and across a phone and a TV as it does in the desktop window", () => {
    const { width, height, pxPerRem } = NEBULA_REFERENCE_WINDOW;
    const reach = (centre: number, radius: number) => centre + radius * NEBULA_FADE_AT;
    // Desktop, in px of the 1280 × 800 window: where the top-left glow has faded out, below and to the right.
    const glow = SKY_NEBULAS.badger[0]!;
    const desktopDown = reach(glow.y * height, glow.ryRem * pxPerRem) / height;
    const desktopRight = reach(glow.x * width, glow.rxRem * pxPerRem) / width;
    // The desktop's glow warms the top 28 % of the window; the old 8 dp-per-rem sizing reached only 9 % of a
    // 412 × 868 dp phone (OnePlus 9 Pro, 2026-11-10).
    expect(desktopDown).toBeCloseTo(0.28, 2);
    for (const [name, w, h] of [
      ["phone", 412, 868],
      ["tv", 960, 540],
    ] as const) {
      const spot = mobileNebulaSpots("badger")[0]!;
      const down = reach(spot.y * h, spot.ry * h) / h;
      const right = reach(spot.x * w, spot.rx * w) / w;
      console.info(`[sky-nebula] ${name} top-left glow reaches`, { down, right, desktopDown, desktopRight });
      expect(down).toBeCloseTo(desktopDown, 5);
      expect(right).toBeCloseTo(desktopRight, 5);
    }
  });
});
