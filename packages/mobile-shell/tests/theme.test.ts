import { describe, expect, it } from "vitest";
import { defaultMobileShellTheme, mergeMobileShellTheme } from "../src/theme";

// On assertion failure, dump the merged theme + the default so a deep-merge
// regression is diagnosable offline ("Tests log generously"). try/catch so a
// dump failure can never mask the real assertion.
const dumpThemeSnapshot = (
  label: string,
  ctx: { merged?: unknown; expectedDefault?: unknown; extra?: Record<string, unknown> },
) => {
  try {
    console.error(`=== [theme:${label}] snapshot ===`);
    if (ctx.merged !== undefined) {
      console.error(`merged theme:\n${JSON.stringify(ctx.merged, null, 2)}`);
    }
    if (ctx.expectedDefault !== undefined) {
      console.error(`default theme:\n${JSON.stringify(ctx.expectedDefault, null, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra=${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mobile shell theme", () => {
  it("returns defaults when overrides are empty", () => {
    console.info(`[theme:defaults-empty] merging with no overrides`);
    const merged = mergeMobileShellTheme();
    try {
      expect(merged).toEqual(defaultMobileShellTheme);
    } catch (err) {
      dumpThemeSnapshot("defaults-empty", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("returns defaults when overrides are null", () => {
    console.info(`[theme:defaults-null] merging with null overrides`);
    const merged = mergeMobileShellTheme(null);
    try {
      expect(merged).toEqual(defaultMobileShellTheme);
    } catch (err) {
      dumpThemeSnapshot("defaults-null", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("applies top-level overrides", () => {
    console.info(`[theme:top-level] overriding brandName=SpaceParrot accentHex=#33cc99`);
    const merged = mergeMobileShellTheme({
      brandName: "SpaceParrot",
      accentHex: "#33cc99",
    });

    console.info(
      `[theme:top-level] result brandName=${merged.brandName} accentHex=${merged.accentHex} accentTextHex=${merged.accentTextHex}`,
    );
    try {
      expect(merged.brandName).toBe("SpaceParrot");
      expect(merged.accentHex).toBe("#33cc99");
      expect(merged.accentTextHex).toBe(defaultMobileShellTheme.accentTextHex);
    } catch (err) {
      dumpThemeSnapshot("top-level", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("deep-merges colors without losing unspecified keys", () => {
    console.info(`[theme:deep-colors] overriding colors.accent=#ff0000 colors.bg=#111111`);
    const merged = mergeMobileShellTheme({
      colors: { accent: "#ff0000", bg: "#111111" },
    });

    console.info(`[theme:deep-colors] result colors=${JSON.stringify(merged.colors)}`);
    try {
      expect(merged.colors.accent).toBe("#ff0000");
      expect(merged.colors.bg).toBe("#111111");
      expect(merged.colors.text).toBe(defaultMobileShellTheme.colors.text);
      expect(merged.colors.border).toBe(defaultMobileShellTheme.colors.border);
    } catch (err) {
      dumpThemeSnapshot("deep-colors", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("deep-merges spacing without losing unspecified keys", () => {
    console.info(`[theme:deep-spacing] overriding spacing.lg=30`);
    const merged = mergeMobileShellTheme({
      spacing: { lg: 30 },
    });

    console.info(`[theme:deep-spacing] result spacing=${JSON.stringify(merged.spacing)}`);
    try {
      expect(merged.spacing.lg).toBe(30);
      expect(merged.spacing.xs).toBe(defaultMobileShellTheme.spacing.xs);
    } catch (err) {
      dumpThemeSnapshot("deep-spacing", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("deep-merges font family and size independently", () => {
    console.info(`[theme:deep-font] overriding font.family.display=Montserrat`);
    const merged = mergeMobileShellTheme({
      font: { family: { display: "Montserrat" } },
    });

    console.info(`[theme:deep-font] result font=${JSON.stringify(merged.font)}`);
    try {
      expect(merged.font.family.display).toBe("Montserrat");
      expect(merged.font.family.sans).toBe(defaultMobileShellTheme.font.family.sans);
      expect(merged.font.size).toEqual(defaultMobileShellTheme.font.size);
    } catch (err) {
      dumpThemeSnapshot("deep-font", { merged, expectedDefault: defaultMobileShellTheme });
      throw err;
    }
  });

  it("does not mutate the default theme", () => {
    console.info(`[theme:no-mutate] snapshotting default theme then merging brandName=Mutant`);
    const before = JSON.parse(JSON.stringify(defaultMobileShellTheme));
    mergeMobileShellTheme({ brandName: "Mutant" });
    console.info(`[theme:no-mutate] default.brandName after merge=${defaultMobileShellTheme.brandName}`);
    try {
      expect(defaultMobileShellTheme).toEqual(before);
    } catch (err) {
      dumpThemeSnapshot("no-mutate", { merged: defaultMobileShellTheme, expectedDefault: before });
      throw err;
    }
  });
});
