/**
 * REL-DIST-13, REL-DIST-14, REL-UPD-07: Parrot's .deb/.rpm/.pacman, built from this app's electron-builder config, pass
 * the shared Linux package checks (@space/desktop-platform-linux/testing/linux-builder-checks): afterPack normalizes the
 * packed app, after-install repairs earlier packages' folders, after-remove acts on a real removal only, the .rpm's
 * %posttrans restores the command, and each format carries spaceparrot's own system-update helper and policy.
 */
import { describe, expect, it } from "vitest";

import { linuxBuilderChecks } from "@space/desktop-platform-linux/testing/linux-builder-checks";

import { createBuilderConfig } from "../electron-builder.config.mjs";

const log = (line: string, data?: unknown) => console.info(`[linux-package-checks] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// @req REL-DIST-13[parrot] the packed app is normalized and the after-install repair runs first
// @req REL-DIST-14[parrot] after-remove acts on a real removal only; the .rpm %posttrans restores the command
// @req REL-UPD-07[parrot] each format carries the app's own system-update helper and policy last in fpm's arguments
describe("Parrot Linux packages pass the shared package checks", () => {
  it("runs every check against this app's config", async () => {
    const checks = await linuxBuilderChecks(createBuilderConfig({ targetId: "linux-x64" }), "spaceparrot");
    for (const { check, actual, expected } of checks) {
      log(check, actual);
      expect(actual, check).toEqual(expected);
    }
    expect(checks.length).toBe(8);
  });
});
