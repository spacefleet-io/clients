import { describe, expect, it } from "vitest";
import { defaultDesktopShellTheme, mergeDesktopShellTheme } from "../src/theme";

describe("desktop shell theme", () => {
  console.info("[desktop-shell-theme:suite] starting desktop shell theme merge tests");

  it("returns defaults when overrides are empty", () => {
    console.info("[desktop-shell-theme:test] mergeDesktopShellTheme() with no overrides → expects defaults");
    const merged = mergeDesktopShellTheme();
    console.info(`[desktop-shell-theme:test] merged=${JSON.stringify(merged)}`);
    expect(merged).toEqual(defaultDesktopShellTheme);
  });

  it("applies partial overrides deterministically", () => {
    const overrides = {
      brandName: "SpaceParrot",
      accentHex: "#33cc99",
      mascotSrc: "/parrot.webp",
    };
    console.info(`[desktop-shell-theme:test] overrides=${JSON.stringify(overrides)}`);
    const merged = mergeDesktopShellTheme(overrides);
    console.info(`[desktop-shell-theme:test] merged=${JSON.stringify(merged)}`);

    expect(merged).toMatchObject({
      brandName: "SpaceParrot",
      accentHex: "#33cc99",
      mascotSrc: "/parrot.webp",
      logoSrc: defaultDesktopShellTheme.logoSrc,
    });
  });
});
