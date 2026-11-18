// Parrot's palette: the fleet's shared dark surfaces (@space/mobile-shell, the same as Badger) with Parrot's green
// accent (UX-THEME-02). Only the accent differs from Badger, so the two read as one fleet.
import { mergeMobileShellTheme } from "@space/mobile-shell/theme";
import { mobileNebulaSpots } from "@space/shared/skyNebula";

/** Parrot green, desktop `--primary: 150 70% 56%`: 10.4:1 on the background (WCAG AA). */
export const PARROT_ACCENT = "#40dd8f";

/**
 * Parrot's nebula (PAR-LOOK-01, UX-SKY-03): the shared green glows of `@space/shared/skyNebula` (the ones the desktop
 * and web player paint), sized in dp for a phone. `MobileAppBackdrop` paints it under the stars.
 */
export const PARROT_NEBULA = mobileNebulaSpots("parrot");

export const parrotShellTheme = mergeMobileShellTheme({
  brandName: "Parrot",
  nebula: PARROT_NEBULA,
  accentHex: PARROT_ACCENT,
  colors: { accent: PARROT_ACCENT, accentSoft: "#19322f" },
});

const shell = parrotShellTheme.colors;

export const colors = {
  bg: shell.bg,
  surface: shell.surface,
  surfaceRaised: shell.surfaceRaised,
  border: shell.border,
  text: shell.text,
  textMuted: shell.textMuted,
  accent: shell.accent,
  accentText: parrotShellTheme.accentTextHex,
  danger: shell.danger,
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
