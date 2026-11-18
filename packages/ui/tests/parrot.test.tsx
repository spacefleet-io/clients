import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parrotCoverArt, parrotSeedHash, parrotWaveBars } from "@space/parrot-core/art";
import { ParrotCover, ParrotWaveSeek } from "../src/parrot/components";

// @req PAR-LOOK-01
describe("[parrot] drawn art", () => {
  it("gives one album the same picture every time and different albums different pictures", () => {
    const a = parrotCoverArt("album-1");
    const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(parrotCoverArt(`album-${i}`))));
    console.info("[parrot-art] album-1", a, "distinct of 40:", seen.size);
    expect(parrotCoverArt("album-1")).toEqual(a);
    expect(a.from).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    expect(seen.size).toBeGreaterThan(10);
    expect(parrotSeedHash("x")).toBe(parrotSeedHash("x"));
  });

  it("draws a stable wave of the asked length, every bar between 0.12 and 1", () => {
    const bars = parrotWaveBars("song-7", 96);
    console.info("[parrot-art] wave head", bars.slice(0, 8));
    expect(bars).toHaveLength(96);
    expect(parrotWaveBars("song-7", 96)).toEqual(bars);
    for (const bar of bars) {
      expect(bar).toBeGreaterThanOrEqual(0.12);
      expect(bar).toBeLessThanOrEqual(1);
    }
  });

  it("colours the played part of the wave green and exposes it as a slider", () => {
    const html = renderToStaticMarkup(<ParrotWaveSeek seed="s" progress={0.5} bars={10} label="Seek" valueText="1:00 of 2:00" />);
    console.info("[parrot-art] wave markup", html);
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html.match(/bg-primary/g)).toHaveLength(5);
  });

  it("rings the playing album and shows the equaliser badge", () => {
    const html = renderToStaticMarkup(<ParrotCover seed="a" label="Low Orbit" playing />);
    console.info("[parrot-art] cover markup", html);
    expect(html).toContain("outline-primary");
    expect(html).toContain("parrot-eq");
    expect(html).toContain("Low Orbit");
    expect(renderToStaticMarkup(<ParrotCover seed="a" />)).not.toContain("parrot-eq");
  });

  // @req PAR-META-04
  // @req PAR-LOOK-01[parrot-web-player]
  it("shows the drawn picture at once and fades the album's own cover in over it; without a cover only the drawn picture", () => {
    const withCover = renderToStaticMarkup(<ParrotCover seed="a" label="Low Orbit" playing src="http://127.0.0.1:1/s/cover/al-1" />);
    const drawn = renderToStaticMarkup(<ParrotCover seed="a" label="Low Orbit" />);
    const noCover = renderToStaticMarkup(<ParrotCover seed="a" label="Low Orbit" src={null} />);
    console.info("[parrot-art] cover with src", withCover);
    console.info("[parrot-art] cover without src", drawn);
    expect(withCover).toContain('<img src="http://127.0.0.1:1/s/cover/al-1"');
    expect(withCover).toContain("object-cover");
    // Until the picture has loaded it is transparent over the drawn picture (and its label), then it fades in.
    expect(withCover).toContain('data-cover="loading"');
    const img = withCover.slice(withCover.indexOf("<img"), withCover.indexOf(">", withCover.indexOf("<img")));
    console.info("[parrot-art] img tag", img);
    expect(img).toContain("opacity-0");
    expect(img).toContain("motion-safe:transition-opacity");
    expect(withCover).toContain("Low Orbit");
    // Ring and equaliser stay on top.
    expect(withCover).toContain("outline-primary");
    expect(withCover).toContain("parrot-eq");
    for (const html of [drawn, noCover]) {
      expect(html).not.toContain("<img");
      expect(html).toContain('data-cover="drawn"');
      expect(html).toContain("pointer-events-none absolute");
      expect(html).toContain("Low Orbit");
    }
  });
});
