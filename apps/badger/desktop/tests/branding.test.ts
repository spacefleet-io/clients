import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const mainPath = resolve(import.meta.dirname, "../src/main/index.ts");
const indexHtmlPath = resolve(import.meta.dirname, "../src/renderer/index.html");
const i18nEnPath = resolve(import.meta.dirname, "../src/renderer/src/i18n/en.json");
const i18nFrPath = resolve(import.meta.dirname, "../src/renderer/src/i18n/fr.json");

describe("badger desktop branding", () => {
  // @req REL-MAC-09 the in-app brand reads "Badger" on every OS
  it("uses the short app title across window and renderer branding", () => {
    const mainSource = readFileSync(mainPath, "utf8");
    const indexHtml = readFileSync(indexHtmlPath, "utf8");
    const i18nEn = JSON.parse(readFileSync(i18nEnPath, "utf8")) as { brand?: { app?: string } };
    const i18nFr = JSON.parse(readFileSync(i18nFrPath, "utf8")) as { brand?: { app?: string } };

    // The name passed to app.setName comes from the platform layer (appIdentity.ts):
    // "Badger" on every OS (tests/app-identity.test.ts, REL-MAC-09).
    expect(mainSource).toContain("app.setName(appIdentity.name)");
    expect(indexHtml).toContain("<title>Badger</title>");
    expect(i18nEn.brand?.app).toBe("Badger");
    expect(i18nFr.brand?.app).toBe("Badger");
  });

  it("gives the Linux window the .desktop entry's class, so the taskbar shows Badger's own entry @req REL-MAC-09", () => {
    const mainSource = readFileSync(mainPath, "utf8");
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { desktopName: string };
    expect(pkg.desktopName).toBe("spacebadger.desktop");
    expect(mainSource).toContain('linuxWindowClass: "spacebadger"');
  });
});
