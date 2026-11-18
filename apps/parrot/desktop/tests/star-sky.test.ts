/**
 * @why Chris 2026-11-09: Parrot had Badger's green-nebula night background but not the starry sky with shooting stars.
 *   The shared sky (`@space/ui/app-backdrop`) is mounted once at the renderer root, so setup, sign-in and the library
 *   all show it, above the nebula painted on body and below the page.
 * @covers apps/parrot/desktop/src/renderer/src/main.tsx
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TAG = "[parrot-desktop:star-sky]";

describe("Parrot desktop star sky", () => {
  // @req UX-SKY-01[parrot]
  it("mounts the shared star sky once at the renderer root, under the page and over the nebula", () => {
    const main = readFileSync(resolve(__dirname, "../src/renderer/src/main.tsx"), "utf8");
    const styles = readFileSync(resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
    const backdropAt = main.indexOf('<AppBackdrop nebula="parrot" />');
    const pageLayerAt = main.indexOf('<div className="relative z-10">');
    const appAt = main.indexOf("<App />");
    const mounts = main.split('<AppBackdrop nebula="parrot" />').length - 1;
    console.info(`${TAG} mounts=${mounts} backdropAt=${backdropAt} pageLayerAt=${pageLayerAt} appAt=${appAt}`);
    console.info(`${TAG} styles own gradient=${styles.includes("radial-gradient")}`);

    expect(main).toContain('import AppBackdrop from "@space/ui/app-backdrop"');
    expect(mounts).toBe(1);
    // The sky first, then the page in a positioned layer above it (the sky is `fixed z-0`).
    expect(backdropAt).toBeGreaterThan(-1);
    expect(pageLayerAt).toBeGreaterThan(backdropAt);
    expect(appAt).toBeGreaterThan(pageLayerAt);
    // The green nebula comes with the sky (UX-SKY-03), not from the app's CSS.
    expect(styles).not.toContain("radial-gradient");
  });
});
