/**
 * @test-id MOBILE-PLAYER-ACCENT-001
 * @level unit
 * @req PLAY-LOOK-01[badger-mobile,badger-tv,badger-desktop]
 * @why PLAY-LOOK-01: the player's accent is Badger yellow on every app. The
 *   phone / TV controls default, the player overlays, and the desktop mpv
 *   OSC and track menu each hold the colour in their own syntax, so each is
 *   checked against the shell theme's one accent.
 * @regression-proof
 *   The player kept the salmon #f7a26e while the rest of Badger was #ffb357.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMobileShellTheme } from "@space/mobile-shell/theme";

const ROOT = resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const accent = defaultMobileShellTheme.colors.accent.toLowerCase();
const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));

describe("PLAY-LOOK-01: the player accent is Badger yellow", () => {
  it("the shell accent is Badger yellow", () => {
    expect(accent).toBe("#ffb357");
  });

  it("the phone and TV controls default to the shell accent, unplayed track at 0.30", () => {
    const src = read("packages/mobile-mpv-playback/src/components/PlayerControls.tsx");
    const block = src.match(/const DEFAULT_THEME[^{]*\{([\s\S]*?)\};/)?.[1] ?? "";
    expect(block).toContain(`accent: "${accent}"`);
    expect(block).toContain(`unplayedAccent: "rgba(${r}, ${g}, ${b}, 0.30)"`);
  });

  it("the player screen and overlays take the accent from the shell theme, not a literal", () => {
    const screen = read("apps/badger/mobile/src/screens/PlayerScreen.tsx");
    expect(screen).toMatch(/theme=\{CONTROLS_THEME\}/);
    expect(screen).toMatch(/const CONTROLS_THEME = \{ accent: theme\.colors\.accent \}/);
    const overlays = read("apps/badger/mobile/src/screens/player/PlayerOverlays.tsx");
    expect(overlays).not.toMatch(/#f7a26e/i);
    expect(overlays.match(/theme\.colors\.accent/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the desktop OSC and track menu use the same accent", () => {
    const bgr = [b, g, r].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    expect(read("packages/mpv/resources/osc/tog4in1/tog4in1.lua")).toMatch(new RegExp(`local accent = "${bgr}"`));
    expect(read("packages/mpv/resources/osc/sf-select.lua").toLowerCase()).toContain(`console-match_color=${accent}`);
  });
});
