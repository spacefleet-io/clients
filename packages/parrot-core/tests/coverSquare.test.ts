/**
 * @test-id PARROT-CORE-COVERSQUARE-001
 * @level unit
 * @why PAR-META-22: album covers are square. A picture keeps its centre square unless the user framed another, and
 *      the framing is kept in shares of the picture so one framing holds on the 500 px preview and the 1200 px cover.
 * @covers packages/parrot-core/src/covers.ts
 */
import { describe, expect, it } from "bun:test";
import { isParrotCoverCrop, parrotCoverCropOf, parrotCoverSquare } from "../src/covers";

describe("parrot cover square (PAR-META-22)", () => {
  it("keeps the centre square when nothing is framed", () => {
    expect(parrotCoverSquare(1600, 900)).toEqual({ x: 350, y: 0, side: 900 });
    expect(parrotCoverSquare(600, 1000)).toEqual({ x: 0, y: 200, side: 600 });
    expect(parrotCoverSquare(500, 500)).toEqual({ x: 0, y: 0, side: 500 });
  });

  it("a framing made on the preview lands on the same part of the full picture", () => {
    // Framed on a 500 × 281 preview of a 16:9 picture: the left-hand 200 px square, 40 px down.
    const crop = parrotCoverCropOf(500, 281, { x: 20, y: 40, side: 200 });
    const full = parrotCoverSquare(1920, 1080, crop);
    console.info("[cover-square] crop", crop, "full", full);
    expect(full.x).toBe(Math.round((20 / 500) * 1920));
    expect(full.y).toBe(Math.round((40 / 281) * 1080));
    expect(full.side).toBe(Math.round((200 / 281) * 1080));
  });

  it("clamps a framing that runs off the picture back inside it", () => {
    expect(parrotCoverSquare(1600, 900, { left: 0.9, top: 0.5, size: 1 })).toEqual({ x: 700, y: 0, side: 900 });
    expect(parrotCoverSquare(1600, 900, { left: 0, top: 0, size: 3 })).toEqual({ x: 0, y: 0, side: 900 });
  });

  it("takes only three shares between 0 and 1 as a framing, the size above nothing", () => {
    expect(isParrotCoverCrop({ left: 0.1, top: 0, size: 0.5 })).toBe(true);
    expect(isParrotCoverCrop({ left: 0.1, top: 0, size: 0 })).toBe(false);
    expect(isParrotCoverCrop({ left: -0.1, top: 0, size: 0.5 })).toBe(false);
    expect(isParrotCoverCrop({ left: 0.1, top: Number.NaN, size: 0.5 })).toBe(false);
    expect(isParrotCoverCrop("0.1,0,0.5")).toBe(false);
    expect(isParrotCoverCrop(null)).toBe(false);
  });
});
