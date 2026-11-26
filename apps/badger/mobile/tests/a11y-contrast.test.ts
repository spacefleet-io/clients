/**
 * @test-id MOBILE-A11Y-001
 * @level unit
 * @why UX-A11Y-02: text, icons and controls must meet the WCAG AA contrast
 *   levels. The palette is one table (`defaultMobileShellTheme.colors`), so
 *   every foreground role is checked against every surface it can sit on.
 * @regression-proof
 *   textDim #878ca1 on surface #242638 was 4.47:1 (< 4.5:1).
 */
import { describe, expect, it } from "vitest";
import { defaultMobileShellTheme } from "@space/mobile-shell/theme";

const { colors, accentHex, accentTextHex } = defaultMobileShellTheme;

/** WCAG 2.x AA: normal text 4.5:1 (SC 1.4.3); icons, control boundaries and large text 3:1 (SC 1.4.11, 1.4.3). */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const channel = (hex: string, offset: number): number => {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number =>
  0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const surfaces = {
  bg: colors.bg,
  surface: colors.surface,
  surfaceRaised: colors.surfaceRaised,
  accentSoft: colors.accentSoft,
} as const;

const textRoles = {
  text: colors.text,
  textMuted: colors.textMuted,
  textDim: colors.textDim,
  accent: colors.accent,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
} as const;

describe("palette contrast (UX-A11Y-02)", () => {
  it("computes WCAG ratios correctly (black on white is 21:1)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  /** @req UX-A11Y-02[badger-mobile] */
  it.each(Object.entries(textRoles).flatMap(([role, fg]) => Object.entries(surfaces).map(([name, bg]) => [role, fg, name, bg] as const)))(
    "%s %s on %s %s is at least 4.5:1",
    (role, fg, name, bg) => {
      const ratio = contrast(fg, bg);
      console.info(`[a11y-contrast] ${role} ${fg} on ${name} ${bg} = ${ratio.toFixed(2)}:1 (need ${AA_TEXT})`);
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  /** @req UX-A11Y-02[badger-mobile] */
  it("label on the accent and danger buttons is at least 4.5:1", () => {
    for (const [name, bg] of [["accent", accentHex], ["danger", colors.danger]] as const) {
      const ratio = contrast(accentTextHex, bg);
      console.info(`[a11y-contrast] accentText ${accentTextHex} on ${name} button ${bg} = ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  /** @req UX-A11Y-02[badger-mobile] */
  it("icons and focus accents are at least 3:1 on the app and card backgrounds", () => {
    for (const [role, fg] of Object.entries({ accent: colors.accent, success: colors.success, danger: colors.danger, text: colors.text })) {
      for (const [name, bg] of [["bg", colors.bg], ["surface", colors.surface]] as const) {
        const ratio = contrast(fg, bg);
        console.info(`[a11y-contrast] icon ${role} ${fg} on ${name} ${bg} = ${ratio.toFixed(2)}:1 (need ${AA_NON_TEXT})`);
        expect(ratio).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
  });

  /** @req UX-A11Y-02[badger-mobile] */
  it("text input boundary is at least 3:1 against the app and card backgrounds", () => {
    for (const [name, bg] of [["bg", colors.bg], ["surface", colors.surface]] as const) {
      const ratio = contrast(colors.controlBorder, bg);
      console.info(`[a11y-contrast] controlBorder ${colors.controlBorder} on ${name} ${bg} = ${ratio.toFixed(2)}:1 (need ${AA_NON_TEXT})`);
      expect(ratio).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});
