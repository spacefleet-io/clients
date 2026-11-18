/**
 * REL-DIST-14: the .deb/.rpm/.pacman keep the /usr/bin command across an update. electron-builder's after-remove script
 * dropped it on every call, and rpm runs the old package's %postun after the new package's %post (seen on Fedora:
 * `dnf upgrade` badger 0.1.0 -> 0.1.1 left /usr/bin/spacebadger missing). The after-remove script now acts on a real
 * removal only, and the .rpm's %posttrans puts back a link an earlier package's %postun removed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBuilderConfig as badgerBuilderConfig } from "../../../apps/badger/desktop/electron-builder.config.mjs";
import { createBuilderConfig as parrotBuilderConfig } from "../../../apps/parrot/desktop/electron-builder.config.mjs";
import { REMOVAL_ONLY } from "../packaging/linux-packages.mjs";

const log = (line: string, data?: unknown) => console.info(`[package-scripts] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-package-scripts-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Formats = Record<"deb" | "rpm" | "pacman", { afterRemove?: string; fpm?: string[] }>;
const apps = () =>
  [
    ["badger", "spacebadger", badgerBuilderConfig({ targetId: "linux-x64" }) as unknown as Formats],
    ["parrot", "spaceparrot", parrotBuilderConfig({ targetId: "linux-x64" }) as unknown as Formats],
  ] as const;

// @req REL-DIST-14[badger-desktop,parrot] an update keeps the /usr/bin command: the after-remove script acts on a real removal only
describe("after-remove acts on a real removal only (REL-DIST-14)", () => {
  it("both apps' .deb/.rpm/.pacman run electron-builder's after-remove script behind the removal check", () => {
    for (const [app, , formats] of apps()) {
      const scripts = new Set([formats.deb.afterRemove, formats.rpm.afterRemove, formats.pacman.afterRemove]);
      expect(scripts.size, app).toBe(1);
      const [path] = [...scripts];
      if (typeof path !== "string") throw new Error(`${app}: no afterRemove`);
      const lines = readFileSync(path, "utf8").split("\n");
      log(`${app} after-remove`, { path, head: lines.slice(0, REMOVAL_ONLY.length + 2) });
      expect(lines.slice(0, REMOVAL_ONLY.length + 1), app).toEqual(["#!/bin/bash", ...REMOVAL_ONLY]);
      expect(lines.join("\n"), app).toContain("update-alternatives --remove");
    }
  });

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

// @req REL-DIST-14[badger-desktop,parrot] the .rpm %posttrans puts back the command an earlier package's %postun removed
describe("rpm %posttrans restores the command (REL-DIST-14)", () => {
  it("relinks /usr/bin/<package> through update-alternatives when it is missing, and leaves a present one alone", () => {
    for (const [app, packageName, formats] of apps()) {
      const fpm = formats.rpm.fpm ?? [];
      const path = fpm[fpm.indexOf("--rpm-posttrans") + 1];
      if (!fpm.includes("--rpm-posttrans") || typeof path !== "string") throw new Error(`${app}: no --rpm-posttrans`);
      const root = tmp();
      const bin = join(root, "usr-bin");
      const fakes = join(root, "fakes");
      spawnSync("mkdir", ["-p", bin, fakes]);
      const calls = join(root, "calls");
      // rpm -ql lists the package's files; update-alternatives records its arguments and makes the link.
      writeFileSync(join(fakes, "rpm"), `#!/bin/sh\necho /opt/Product/resources/app.asar\necho /opt/Product/${packageName}\n`);
      writeFileSync(join(fakes, "update-alternatives"), `#!/bin/sh\necho "$@" >> '${calls}'\nln -sf "$5" "$2"\n`);
      for (const fake of ["rpm", "update-alternatives"]) chmodSync(join(fakes, fake), 0o755);
      const script = readFileSync(path, "utf8").replaceAll("/usr/bin/", `${bin}/`);
      const run = () => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${fakes}:/usr/bin:/bin` } });

      const missing = run();
      const recorded = existsSync(calls) ? readFileSync(calls, "utf8").trim() : "";
      log(`${app} posttrans with the link missing`, { status: missing.status, stderr: missing.stderr, recorded });
      expect(missing.status, app).toBe(0);
      expect(recorded, app).toBe(`--install ${bin}/${packageName} ${packageName} /opt/Product/${packageName} 100`);

      rmSync(calls);
      // unlinkSync, not rmSync: the fake leaves a dangling link, which Node 24's rmSync leaves in place
      unlinkSync(join(bin, packageName));
      // a working link (a dangling one counts as missing and is relinked)
      symlinkSync(join(fakes, "rpm"), join(bin, packageName));
      const present = run();
      log(`${app} posttrans with the link present`, { status: present.status, called: existsSync(calls) });
      expect(present.status, app).toBe(0);
      expect(existsSync(calls), app).toBe(false);
    }
  });
});
