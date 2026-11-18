export type DesktopShellTheme = {
  brandName: string;
  logoSrc: string;
  mascotSrc: string;
  accentHex: string;
  accentTextHex: string;
  cardClassName: string;
  pageClassName: string;
  navClassName: string;
};

export const defaultDesktopShellTheme: DesktopShellTheme = {
  brandName: "SpaceFleet",
  logoSrc: "/icon.png",
  mascotSrc: "/mascot.webp",
  accentHex: "#ffaa54",
  accentTextHex: "#0d1117",
  cardClassName: "w-full",
  pageClassName: "min-h-screen",
  navClassName: "fixed inset-x-0 top-0",
};

export const mergeDesktopShellTheme = (
  overrides?: Partial<DesktopShellTheme> | null
): DesktopShellTheme => ({
  ...defaultDesktopShellTheme,
  ...(overrides ?? {}),
});
