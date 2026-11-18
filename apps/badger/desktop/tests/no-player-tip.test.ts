/**
 * UX-TOUR-03: Badger's player has no tip. Chris 2026-11-13 (via Main): remove the one-time "Missing subtitles?" player
 * tip completely; the S shortcut and the "Get more subtitles…" row stay.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_TOUR_STORAGE_KEYS, desktopTourStrings } from "@space/desktop-shell/tour";

const renderer = resolve(__dirname, "../src/renderer/src");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

describe("Badger player tip", () => {
  it("is gone from the renderer, the tour strings and the kept storage keys @req UX-TOUR-03", () => {
    const withTip = sources(renderer).filter((path) => /PlayerTip|player-tip|playerTip|osc-message/.test(readFileSync(path, "utf8")));
    console.info("[no-player-tip.test] renderer files with a player tip", withTip);
    expect(withTip).toEqual([]);
    for (const [language, table] of Object.entries(desktopTourStrings)) {
      const tipKeys = Object.keys(table).filter((key) => key.includes("playerTip"));
      console.info(`[no-player-tip.test] ${language} tip strings`, tipKeys);
      expect(tipKeys).toEqual([]);
    }
    expect(DESKTOP_TOUR_STORAGE_KEYS.filter((key) => key.includes("player_tip"))).toEqual([]);
  });
});
