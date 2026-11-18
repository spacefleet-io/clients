/**
 * @test-id MOBILE-A11Y-002
 * @level unit
 * @why UX-A11Y-05: phone text follows the phone's own text-size setting
 *   (Dynamic Type on iOS, font scale on Android) on every screen, and no text
 *   is drawn below 11 pt at the default setting (Apple's guideline floor).
 *   Sizes are literals in the phone screens, the shared components and the
 *   theme scale, so the source is scanned for both halves.
 * @regression-proof
 *   A `fontSize: 10` caption, `allowFontScaling={false}` or a
 *   `maxFontSizeMultiplier` anywhere in the phone source fails this test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMobileShellTheme } from "../../../../packages/mobile-shell/src/theme";

const MIN_PT = 11;
const repo = path.resolve(__dirname, "../../../..");
/** Phone source: the phone app (TV screens live in `src/tv` and are badger-tv) and the shared mobile shell. */
const roots = ["apps/badger/mobile/src", "packages/mobile-shell/src"];
const tvDir = "apps/badger/mobile/src/tv";

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel !== tvDir) walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test\.tsx?|d\.ts)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
};

type Hit = { file: string; line: number; text: string };
const scan = (files: string[], pattern: RegExp): Hit[] => {
  const hits: Hit[] = [];
  for (const file of files) {
    readFileSync(path.join(repo, file), "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
      });
  }
  return hits;
};

describe("phone text size @req UX-A11Y-05[badger-mobile]", () => {
  const files = sourceFiles();

  it("scans the phone screens and the shared shell", () => {
    console.info("[a11y-text-size:files]", { count: files.length, roots });
    expect(files.length).toBeGreaterThan(20);
  });

  it("draws no literal font size below 11 pt", () => {
    const literal = /fontSize\s*(?::|=\{)\s*(\d+(?:\.\d+)?)/g;
    const sizes: Array<Hit & { pt: number }> = [];
    for (const file of files) {
      readFileSync(path.join(repo, file), "utf8")
        .split("\n")
        .forEach((text, i) => {
          for (const m of text.matchAll(literal)) sizes.push({ file, line: i + 1, text: text.trim(), pt: Number(m[1]) });
        });
    }
    const tooSmall = sizes.filter((s) => s.pt < MIN_PT);
    console.info("[a11y-text-size:literals]", {
      count: sizes.length,
      smallest: Math.min(...sizes.map((s) => s.pt)),
      tooSmall,
    });
    expect(sizes.length).toBeGreaterThan(0);
    expect(tooSmall).toEqual([]);
  });

  it("keeps every step of the theme scale at 11 pt or more", () => {
    const scale = defaultMobileShellTheme.font.size;
    console.info("[a11y-text-size:theme]", scale);
    for (const [step, pt] of Object.entries(scale)) expect({ step, pt: pt >= MIN_PT }).toEqual({ step, pt: true });
  });

  it("never turns off or caps the phone's text-size setting", () => {
    const hits = scan(files, /allowFontScaling|maxFontSizeMultiplier|adjustsFontSizeToFit|minimumFontScale/);
    console.info("[a11y-text-size:scaling-overrides]", hits);
    expect(hits).toEqual([]);
  });
});
