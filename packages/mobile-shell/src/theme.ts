import { createContext, useContext } from "react";
import type { MobileNebulaSpot } from "./components/mobile-nebula";
import type { ImageSourcePropType } from "react-native";

export type MobileShellTheme = {
  brandName: string;
  logoSource: ImageSourcePropType;
  mascotSource: ImageSourcePropType;
  accentHex: string;
  accentTextHex: string;
  colors: {
    bg: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    /** Text input / control outline: >= 3:1 on bg and surface (WCAG 1.4.11). `border` is decorative only. */
    controlBorder: string;
    text: string;
    textMuted: string;
    textDim: string;
    accent: string;
    accentSoft: string;
    success: string;
    warning: string;
    danger: string;
  };
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  radius: {
    sm: number;
    md: number;
    lg: number;
    pill: number;
  };
  /** The app's nebula under the star field (`mobileNebulaSpots`: Badger's yellow, Parrot's green); none by default. */
  nebula?: MobileNebulaSpot[];
  font: {
    family: {
      sans: string;
      display: string;
    };
    size: {
      xs: number;
      sm: number;
      md: number;
      lg: number;
      xl: number;
      xxl: number;
    };
  };
};

// Desktop Badger palette (apps/badger/desktop/src/renderer/src/styles.css, dark
// HSL tokens converted to hex): background 231 29% 10%, card 232 22% 18%,
// secondary 231 17% 24%, border 231 14% 31%, foreground 228 42% 90%,
// muted-foreground 228 20% 76%, primary/accent 33 100% 67%, destructive 358 75% 59%.
// This is the single source of truth: the app theme (apps/badger/mobile/src/theme)
// re-exports it.
export const defaultMobileShellTheme: MobileShellTheme = {
  brandName: "SpaceFleet",
  logoSource: { uri: "" },
  mascotSource: { uri: "" },
  accentHex: "#ffb357",
  accentTextHex: "#121421",
  colors: {
    bg: "#121421",
    surface: "#242638",
    surfaceRaised: "#333648",
    border: "#44475a",
    controlBorder: "#757a91",
    text: "#dbdff0",
    textMuted: "#b6bace",
    textDim: "#9ca0b1",
    accent: "#ffb357",
    accentSoft: "#372d2a",
    success: "#70dbaf",
    warning: "#ffb357",
    danger: "#ed8084",
  },
  spacing: {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 8,
    md: 14,
    lg: 20,
    pill: 999,
  },
  font: {
    family: {
      sans: "Inter",
      display: "Space Grotesk",
    },
    size: {
      xs: 12,
      sm: 14,
      md: 16,
      lg: 20,
      xl: 26,
      xxl: 32,
    },
  },
};

export type MobileShellThemeOverrides = Partial<
  Omit<MobileShellTheme, "colors" | "spacing" | "radius" | "font"> & {
    colors: Partial<MobileShellTheme["colors"]>;
    spacing: Partial<MobileShellTheme["spacing"]>;
    radius: Partial<MobileShellTheme["radius"]>;
    font: Partial<{
      family: Partial<MobileShellTheme["font"]["family"]>;
      size: Partial<MobileShellTheme["font"]["size"]>;
    }>;
  }
>;

export const mergeMobileShellTheme = (
  overrides?: MobileShellThemeOverrides | null,
): MobileShellTheme => {
  if (!overrides) return { ...defaultMobileShellTheme };

  return {
    ...defaultMobileShellTheme,
    ...overrides,
    colors: { ...defaultMobileShellTheme.colors, ...overrides.colors },
    spacing: { ...defaultMobileShellTheme.spacing, ...overrides.spacing },
    radius: { ...defaultMobileShellTheme.radius, ...overrides.radius },
    font: {
      family: { ...defaultMobileShellTheme.font.family, ...overrides.font?.family },
      size: { ...defaultMobileShellTheme.font.size, ...overrides.font?.size },
    },
  };
};

const MobileShellThemeContext = createContext<MobileShellTheme>(defaultMobileShellTheme);

export const MobileShellThemeProvider = MobileShellThemeContext.Provider;

export const useMobileShellTheme = (): MobileShellTheme => useContext(MobileShellThemeContext);

/**
 * The greyed-out look of something that cannot play: a season or episode with no file (UX-TV-08, desktop
 * `opacity-40 grayscale`), and, while the phone is offline, what is not kept on it (PAR-OFFL-04). Put it on the
 * content inside a pressable or focusable, never on the focusable itself, so a focus ring keeps its full strength
 * (UX-A11Y-04).
 */
export const UNAVAILABLE_LOOK = { opacity: 0.4, filter: [{ grayscale: 1 }] } as const;
