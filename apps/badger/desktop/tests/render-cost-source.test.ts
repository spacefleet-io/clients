import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Render cost without a GPU (issue #25, low-end target): source-level guards for
// the paint-cost fixes measured with e2e-perf/render-cost.perf.test.ts.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("render cost source guards (software compositing)", () => {
  console.info("[render-cost-source:suite] guarding the no-GPU paint-cost fixes");

  it("[@bugfix][@regression-proof] styles.css has no dead radix overlay blur override and defines the library card containment class", () => {
    const css = read("src/renderer/src/styles.css");
    expect(css).not.toContain("data-radix-dialog-overlay");
    const rule = /\.library-card-cv\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    console.info(`[render-cost-source:test] .library-card-cv rule="${rule.replace(/\s+/g, " ").trim()}"`);
    expect(rule).toContain("content-visibility: auto");
    expect(rule).toMatch(/contain-intrinsic-size:\s*auto 210px auto 354px/);
  });

  it("[@bugfix][@regression-proof] library grid cards use the containment class unless their playlist menu is open", () => {
    const library = read("src/renderer/src/pages/Library.tsx");
    expect(library).toContain('menuOpenId === item.id ? "" : "library-card-cv"');
  });
});
