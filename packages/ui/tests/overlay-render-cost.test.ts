import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Full-viewport overlays must not use a live backdrop-filter: with software
// compositing (no GPU) the blur of the whole page behind the overlay is
// recomputed on the CPU for every frame while it is open. Live A/B on a 4-core,
// 200%-quota Linux test machine (e2e-perf, issue #25), 4 details-dialog opens: with the
// blur 5.6-5.8 s of display-compositor draw time and ~130 frames over 50 ms;
// without it 1.0-1.6 s and ~40.
const source = (file: string) => readFileSync(resolve(__dirname, "..", "src", file), "utf8");

describe("overlay render cost (software compositing)", () => {
  console.info("[ui-overlay-render-cost:suite] dialog/sheet overlays must stay free of backdrop-filter");

  it.each(["dialog.tsx", "sheet.tsx"])("[@bugfix][@regression-proof] %s overlay uses a solid scrim, not backdrop-blur", (file) => {
    const text = source(file);
    const overlay = /Overlay[\s\S]*?cn\(\s*"([^"]+)"/.exec(text)?.[1] ?? "";
    console.info(`[ui-overlay-render-cost:test] ${file} overlay classes="${overlay}"`);
    expect(overlay).toContain("fixed inset-0");
    expect(overlay).not.toMatch(/backdrop-(blur|filter)/);
    expect(text).not.toMatch(/backdrop-blur/);
  });
});
