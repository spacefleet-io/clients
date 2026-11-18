import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopTopNavFrame } from "../src/components/desktop-top-nav-frame";

// The fixed top bar must not use a live backdrop-filter: with software
// compositing (no GPU) the blur of everything scrolling underneath is
// recomputed on the CPU every frame. Live A/B on a 4-core, 200%-quota Linux test machine
// (e2e-perf, issue #25): re-adding the blur raised display-compositor draw time
// during a library scroll by ~36% (mean 2.4 s vs 1.75 s per scroll scene).
describe("shell chrome render cost (software compositing)", () => {
  console.info("[top-nav-render-cost:suite] fixed header must stay free of backdrop-filter");

  it("[@bugfix][@regression-proof] the fixed top bar paints a solid translucent background, no backdrop-blur", () => {
    const html = renderToStaticMarkup(<DesktopTopNavFrame brand={<span>brand</span>} />);
    console.info(`[top-nav-render-cost:test] header html=${html.slice(0, 300)}`);
    expect(html).toContain("fixed inset-x-0 top-0");
    expect(html).not.toMatch(/backdrop-(blur|filter)/);
    expect(html).not.toContain("supports-[backdrop-filter]");
  });
});
