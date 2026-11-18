import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const postcssConfig = require("../postcss.config.cjs") as {
  plugins: Record<string, Record<string, unknown>>;
};

const buildPlugins = () =>
  Object.entries(postcssConfig.plugins).map(([name, options]) => {
    const plugin = require(name);
    return typeof plugin === "function" ? plugin(options) : plugin.default(options);
  });

// On failure, dump the compiled-CSS head and any expected token state so a CI
// run shows what the pipeline actually produced (per "Tests log generously").
const dumpStylesSnapshot = (
  label: string,
  ctx: { cssPath?: string; sourceLen?: number; compiledLen?: number; tokens?: Record<string, boolean>; head?: string }
) => {
  try {
    console.error(`=== [styles-pipeline:${label}] snapshot ===`);
    console.error(`cssPath=${ctx.cssPath}`);
    console.error(`sourceLen=${ctx.sourceLen} compiledLen=${ctx.compiledLen}`);
    if (ctx.tokens) console.error(`token presence: ${JSON.stringify(ctx.tokens)}`);
    if (ctx.head) console.error(`compiled head (first 400 chars):\n${ctx.head.slice(0, 400)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("badger renderer styles pipeline", () => {
  it("expands shared tailwind utilities instead of shipping raw @apply rules", async () => {
    const cssPath = resolve(process.cwd(), "src/renderer/src/styles.css");
    console.info(`[styles-pipeline:setup] reading styles.css at ${cssPath}`);
    const source = readFileSync(cssPath, "utf8");
    console.info(`[styles-pipeline:setup] source length=${source.length}, running postcss`);

    const result = await postcss(buildPlugins()).process(source, { from: cssPath });
    console.info(`[styles-pipeline:expand] compiled css length=${result.css.length}`);

    const tokens = {
      ".absolute": result.css.includes(".absolute"),
      ".w-full": result.css.includes(".w-full"),
      "no-@apply": !result.css.includes("@apply"),
    };
    if (Object.values(tokens).some((v) => !v))
      dumpStylesSnapshot("expand-utilities", {
        cssPath,
        sourceLen: source.length,
        compiledLen: result.css.length,
        tokens,
        head: result.css,
      });

    expect(result.css).toContain(".absolute");
    expect(result.css).toContain(".w-full");
    expect(result.css).not.toContain("@apply");
  });

  // The palette lives in `@space/ui/styles/badger-dark.css`, shared with the web player: compile styles.css so the test
  // proves the import resolves and the palette reaches the renderer's CSS.
  it("keeps the softer space palette while preserving badger's orange accent", async () => {
    const cssPath = resolve(process.cwd(), "src/renderer/src/styles.css");
    console.info(`[styles-pipeline:setup] compiling styles.css at ${cssPath} for palette check`);
    const source = readFileSync(cssPath, "utf8");
    const { css } = await postcss(buildPlugins()).process(source, { from: cssPath });

    const expected = [
      "--background: 231 29% 10%",
      "--card: 232 22% 18%",
      "--primary: 33 100% 67%",
      "--accent: 33 100% 67%",
      "--section-style-1: 33 100% 67%",
    ];
    const tokens = Object.fromEntries(expected.map((token) => [token, css.includes(token)]));
    console.info(`[styles-pipeline:palette] token presence=${JSON.stringify(tokens)}`);
    if (Object.values(tokens).some((v) => !v))
      dumpStylesSnapshot("palette", { cssPath, sourceLen: source.length, compiledLen: css.length, tokens, head: css });

    for (const token of expected) expect(css).toContain(token);
    expect(source).toContain('@import "@space/ui/styles/badger-dark.css"');
  });
});
