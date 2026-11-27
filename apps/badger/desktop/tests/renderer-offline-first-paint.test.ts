/**
 * @test-id RENDERER-OFFLINE-FIRST-PAINT-001
 *
 * [@bugfix][@regression-proof] run 7950 movie-playback: the renderer never
 * painted for 15 s. index.html linked the Google Fonts stylesheet in <head>
 * ahead of an inline <script>; an inline script waits for pending style sheets,
 * so the HTML parser stalled on the remote fetch and the renderer entry never
 * ran. A desktop app must not gate its first paint on a third-party request:
 * no remote stylesheet / script / CSS @import, and the UI fonts ship locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TAG = "[renderer-offline-first-paint]";
const rendererDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer");
const indexHtmlPath = join(rendererDir, "index.html");
const stylesPath = join(rendererDir, "src/styles.css");

const REMOTE_URL = /^(https?:)?\/\//i;

/** Every <link rel=stylesheet|preload|...> href and <script src> in the document, with its tag. */
const collectResourceRefs = (html: string) => {
  const refs: Array<{ tag: string; url: string; blocking: boolean }> = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gis)) {
    const tag = match[0];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    if (href) refs.push({ tag, url: href, blocking: /\bstylesheet\b/i.test(rel) });
  }
  for (const match of html.matchAll(/<script\b[^>]*>/gis)) {
    const tag = match[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) refs.push({ tag, url: src, blocking: true });
  }
  return refs;
};

describe("[@bugfix][@regression-proof] renderer first paint does not depend on the network", () => {
  it("index.html loads no stylesheet or script from a remote origin", () => {
    const html = readFileSync(indexHtmlPath, "utf8");
    const refs = collectResourceRefs(html);
    const remote = refs.filter((ref) => ref.blocking && REMOTE_URL.test(ref.url));
    if (remote.length > 0) {
      console.error(`${TAG} remote render-blocking resources in ${indexHtmlPath}:\n${remote.map((r) => `  ${r.tag}`).join("\n")}`);
      console.error(`${TAG} all resource refs: ${JSON.stringify(refs, null, 2)}`);
    }
    expect(remote).toEqual([]);
  });

  it("styles.css imports no remote CSS and serves Inter + Space Grotesk from bundled files", () => {
    const css = readFileSync(stylesPath, "utf8");
    const remoteImports = [...css.matchAll(/@import\s+(?:url\()?\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)].map((m) => m[1]);
    const fontFaces = [...css.matchAll(/@font-face\s*{([^}]*)}/gi)].map((m) => {
      const body = m[1];
      return {
        family: /font-family\s*:\s*["']?([^"';]+)["']?/i.exec(body)?.[1]?.trim(),
        urls: [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((u) => u[1]),
      };
    });
    const missingFiles = fontFaces.flatMap((face) =>
      face.urls.filter((url) => REMOTE_URL.test(url) || !existsSync(resolve(dirname(stylesPath), url))),
    );
    const families = fontFaces.map((face) => face.family);
    if (remoteImports.length > 0 || missingFiles.length > 0 || !families.includes("Inter") || !families.includes("Space Grotesk")) {
      console.error(
        `${TAG} styles.css: remoteImports=${JSON.stringify(remoteImports)} fontFaces=${JSON.stringify(fontFaces)} missingOrRemote=${JSON.stringify(missingFiles)}`,
      );
    }
    expect(remoteImports).toEqual([]);
    expect(families).toEqual(expect.arrayContaining(["Inter", "Space Grotesk"]));
    expect(missingFiles).toEqual([]);
  });
});
