/**
 * @test-id PARROT-MOBILE-THEME-001
 * @level unit
 * @req UX-THEME-02[parrot]
 * @why Chris on the Pixel 8: "the parrot screen i see on the pixel8 has badger yellow main colour instead of the parrot
 *   green". Parrot's phone must use the fleet's shared surfaces with Parrot's own green accent, readable on them.
 */
import { describe, expect, it } from "vitest";
import { defaultMobileShellTheme } from "@space/mobile-shell/theme";
import { colors, PARROT_ACCENT, parrotShellTheme } from "../src/theme";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("Parrot phone palette", () => {
  it("accent is Parrot green, not Badger's amber", () => {
    expect(PARROT_ACCENT).toBe("#40dd8f");
    expect(colors.accent).toBe(PARROT_ACCENT);
    expect(parrotShellTheme.colors.accent).toBe(PARROT_ACCENT);
    expect(colors.accent.toLowerCase()).not.toBe(defaultMobileShellTheme.colors.accent);
    expect(colors.accent.toLowerCase()).not.toBe("#f2b84b");
  });

  it("surfaces and text are the fleet's shared ones (same as Badger)", () => {
    const fleet = defaultMobileShellTheme.colors;
    expect(colors).toMatchObject({ bg: fleet.bg, surface: fleet.surface, surfaceRaised: fleet.surfaceRaised, text: fleet.text });
  });

  it("green passes WCAG AA as text on the background and surfaces, and under dark button text", () => {
    for (const ground of [colors.bg, colors.surface, colors.surfaceRaised]) {
      expect(contrast(colors.accent, ground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(colors.accentText, colors.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
