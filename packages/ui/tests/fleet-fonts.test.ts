import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @req PAR-LOOK-01
const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, "../src/assets/fonts");
const badgerDesktop = resolve(here, "../../../apps/badger/desktop/src/renderer/src/assets/fonts");
const css = readFileSync(resolve(here, "../src/styles/fleet-fonts.css"), "utf8");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("[parrot] fleet fonts", () => {
  it("fleet-fonts.css serves Inter and Space Grotesk from files in this package", () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1]!);
    console.info("[fleet-fonts] urls", urls);
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('font-family: "Space Grotesk"');
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(existsSync(resolve(here, "../src/styles", url)), url).toBe(true);
  });

  // @req UX-SKY-03 (the Parrot web player's half lives in fleet-fonts.web-apps.test.ts)
  it("the Parrot desktop takes the nebula from the shared sky, with no copy in its CSS", () => {
    const app = "apps/parrot/desktop/src/renderer/src";
    const appCss = readFileSync(resolve(here, "../../..", app, "styles.css"), "utf8");
    const main = readFileSync(resolve(here, "../../..", app, "main.tsx"), "utf8");
    console.info("[parrot-nebula]", { app, mountsNebula: main.includes('<AppBackdrop nebula="parrot" />'), ownCopy: appCss.includes("radial-gradient") });
    expect(main).toContain('<AppBackdrop nebula="parrot" />');
    expect(appCss).not.toContain("radial-gradient");
  });

  it("Badger desktop's own copies are the same files, so Badger and Parrot never show different type", () => {
    for (const file of ["InterVariable.woff2", "SpaceGroteskVariable.woff2"]) {
      const a = sha(resolve(shared, file));
      const b = sha(resolve(badgerDesktop, file));
      console.info("[fleet-fonts] sha256", { file, shared: a, badgerDesktop: b });
      expect(a).toBe(b);
    }
  });
});
