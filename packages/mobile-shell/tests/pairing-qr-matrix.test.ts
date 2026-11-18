/**
 * @test-id TV-PAIR-QR-001
 * @level unit
 * @why The TV shows the pairing QR as one SVG path from the pure `qrcode` encoder. A path that loses a module or
 *   misplaces the quiet zone gives a code a phone cannot scan, and the user is left with only the typed code.
 */
import { describe, expect, it } from "vitest";
import { QR_QUIET_ZONE, encodeQr, qrPathData, qrViewSize } from "../src/pairing";

describe("pairing QR", () => {
  it("encodes the pairing payload and draws every dark module exactly once", () => {
    const matrix = encodeQr("https://spacefleet.io/pair/badger?code=ABCDEFGH");
    const path = qrPathData(matrix);
    console.info("[tv-qr:state]", { size: matrix.size, view: qrViewSize(matrix), pathLength: path.length });

    expect(matrix.size).toBeGreaterThanOrEqual(21);
    expect(qrViewSize(matrix)).toBe(matrix.size + QR_QUIET_ZONE * 2);

    // Re-rasterise the path (runs of "M x y h w v1 h-w z") and compare it with the matrix module by module.
    const painted = new Set<string>();
    for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, width] = [Number(match[1]), Number(match[2]), Number(match[3])];
      for (let i = 0; i < width; i += 1) painted.add(`${y - QR_QUIET_ZONE},${x - QR_QUIET_ZONE + i}`);
    }
    let dark = 0;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        const isDark = matrix.dark(row, col);
        if (isDark) dark += 1;
        expect(painted.has(`${row},${col}`)).toBe(isDark);
      }
    }
    expect(painted.size).toBe(dark);
    // The three finder patterns are dark in their corners.
    expect([matrix.dark(0, 0), matrix.dark(0, matrix.size - 1), matrix.dark(matrix.size - 1, 0)]).toEqual([true, true, true]);
  });

  it("gives a longer payload a bigger code", () => {
    expect(encodeQr("https://spacefleet.io/pair/badger?code=" + "A".repeat(120)).size).toBeGreaterThan(encodeQr("x").size);
  });
});
