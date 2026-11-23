/**
 * @test-id UI-FLOAT-CSS-001
 * @level unit
 * @why `.animate-float` (FloatingMascot, the desktop startup cards, the website heroes) is defined once in
 *   `@space/ui/styles/float.css`, still when the system asks for reduced motion, and every client app that uses the class
 *   loads it. The website's stylesheet and pages are checked by WEB-FLOAT-CSS-001 in its own workspace: this package is in
 *   the client export, which names no file of the private website.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const CLIENT_STYLESHEETS = [
  "apps/badger/desktop/src/renderer/src/styles.css",
  "apps/parrot/desktop/src/renderer/src/styles.css",
  "apps/parrot/web-player/src/styles.css",
];

describe("the shared mascot float", () => {
  it("floats 10 px over 6 s and stays still with reduced motion", () => {
    const css = read("packages/ui/src/styles/float.css");
    console.log("[UI-FLOAT-CSS-001] float.css", css.length, "chars");
    expect(css).toMatch(/@keyframes float \{[\s\S]*translateY\(-10px\)/u);
    expect(css).toMatch(/\.animate-float \{\s*animation: float 6s ease-in-out infinite;/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-float \{\s*animation: none;/u);
    expect(JSON.parse(read("packages/ui/package.json")).exports["./styles/float.css"]).toBe("./src/styles/float.css");
  });

  it.each(CLIENT_STYLESHEETS)("%s loads it instead of its own copy", (path) => {
    const css = read(path);
    expect(css).toMatch(/@import ["']@space\/ui\/styles\/float\.css["'];/u);
    expect(css).not.toContain("@keyframes float");
  });

  it("no shared component defines its own copy", () => {
    const path = "packages/site-ui/src/components/MarketingHome.tsx";
    expect(read(path), path).not.toContain("@keyframes float ");
  });
});
