/**
 * Parrot's first-open tour wiring (PAR-TOUR-01..03). Chris 2026-11-12 (chat): "the same comments apply to the parrot
 * setup that should also start with a drag and drop modal with a video as step 1 and should have the same step 2 and
 * 3. The player is self explanatory they don't need a step 4".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const renderer = resolve(__dirname, "../src/renderer/src");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

describe("Parrot tour wiring", () => {
  it("mounts the shared tour with its bundled drop video and the files picker @req PAR-TOUR-01", () => {
    const library = readFileSync(join(renderer, "Library.tsx"), "utf8");
    expect(library).toContain('import tourDropVideo from "./assets/tour-drop.webm"');
    expect(library).toMatch(/<DesktopTourHost\s+app="parrot"/);
    expect(library).toContain('onPickFiles={() => pickAndScan("files")}');
    const video = statSync(join(renderer, "assets/tour-drop.webm"));
    console.info("[tour-wiring.test] drop video bytes", video.size);
    expect(video.size).toBeGreaterThan(0);
    expect(video.size).toBeLessThan(1_000_000);
    expect(readFileSync(join(renderer, "ImportReview.tsx"), "utf8")).toContain('data-tour="import-review"');
  });

  it("has no player tip anywhere in the app @req PAR-TOUR-03", () => {
    const withTip = sources(renderer).filter((path) => /PlayerTip|player-tip|playerTip/.test(readFileSync(path, "utf8")));
    console.info("[tour-wiring.test] files with a player tip", withTip);
    expect(withTip).toEqual([]);
  });
});
