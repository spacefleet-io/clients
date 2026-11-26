/**
 * REL-DIST-14: the .deb/.rpm/.pacman keep the /usr/bin command across an update. electron-builder's after-remove script
 * dropped it on every call, and rpm runs the old package's %postun after the new package's %post (seen on Fedora:
 * `dnf upgrade` badger 0.1.0 -> 0.1.1 left /usr/bin/spacebadger missing). The after-remove script now acts on a real
 * removal only, and the .rpm's %posttrans puts back a link an earlier package's %postun removed (run against each
 * app's own package in its tests, through testing/linuxBuilderChecks.ts).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { REMOVAL_ONLY } from "../packaging/linux-packages.mjs";

const log = (line: string, data?: unknown) => console.info(`[package-scripts] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// Each app's own tests check that its .deb/.rpm/.pacman run this script and the .rpm's %posttrans
// (@space/desktop-platform-linux/testing/linux-builder-checks); this file pins the script's outcomes.
// @req REL-DIST-14[badger-desktop,parrot] an update keeps the /usr/bin command: the after-remove script acts on a real removal only
describe("after-remove acts on a real removal only (REL-DIST-14)", () => {
  it("goes on for rpm erase, dpkg remove/purge and pacman post_remove; stops for every update call", () => {
    const script = [...REMOVAL_ONLY, "echo removed"].join("\n");
    const outcome = (arg: string) => spawnSync("bash", ["-c", script, "after-remove", arg], { encoding: "utf8" }).stdout.trim() || "kept";
    const calls = ["0", "remove", "purge", "0.1.2-1", "1.0.0-1", "", "1", "2", "upgrade", "failed-upgrade", "abort-install", "abort-upgrade", "disappear"];
    const results = Object.fromEntries(calls.map((arg) => [arg, outcome(arg)]));
    log("after-remove by argument", results);
    expect(results).toEqual({
      "0": "removed",
      remove: "removed",
      purge: "removed",
      "0.1.2-1": "removed",
      "1.0.0-1": "removed",
      "": "removed",
      "1": "kept",
      "2": "kept",
      upgrade: "kept",
      "failed-upgrade": "kept",
      "abort-install": "kept",
      "abort-upgrade": "kept",
      disappear: "kept",
    });
  });
});
