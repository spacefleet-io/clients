/**
 * REL-DIST-13: the .deb/.rpm/.pacman install root-owned files nobody else can modify. Parrot 0.1.2 and Badger 0.1.1
 * shipped app.asar, app-update.yml, the .desktop file and the icons 666 and their folders 777, because the CI job
 * containers run with umask 000 and fpm keeps the modes it finds. The build now normalizes the packed app
 * (u=rwX,go=rX, electron-builder afterPack) under umask 022, and the release refuses a package with any group- or
 * world-writable, setuid or setgid entry (check-package-modes.mjs).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_MODES_REPAIR,
  listPackageEntries,
  modeViolation,
  normalizeTreeModes,
  packageModeViolations,
  parseMtree,
  parseRpmModes,
  withLinuxModes,
} from "../packaging/file-modes.mjs";
import { modeOf, writeUmask000Tree } from "../testing/linuxBuilderChecks";

const CHECK = resolve(import.meta.dirname, "..", "packaging", "check-package-modes.mjs");
const log = (line: string, data?: unknown) => console.info(`[package-modes] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-package-modes-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree a correct build leaves: 755 folders and executables, 644 files. */
const writeGoodTree = (root: string) => {
  writeUmask000Tree(root);
  normalizeTreeModes(root);
};

// @req REL-DIST-13[badger-desktop,parrot] the packed app is normalized to u=rwX,go=rX before any package is built
describe("normalizing the packed app (REL-DIST-13)", () => {
  it("sets folders and executables to 755, everything else to 644, clears setuid, leaves symlinks", () => {
    const root = tmp();
    writeUmask000Tree(root);
    const changed = normalizeTreeModes(root);
    const app = join(root, "opt", "Parrot");
    const modes = {
      opt: modeOf(join(root, "opt")),
      resources: modeOf(join(app, "resources")),
      asar: modeOf(join(app, "resources", "app.asar")),
      updateYml: modeOf(join(app, "resources", "app-update.yml")),
      executable: modeOf(join(app, "spaceparrot")),
      sandbox: modeOf(join(app, "chrome-sandbox")),
    };
    log("normalized", { changed, modes });
    expect(modes).toEqual({ opt: "755", resources: "755", asar: "644", updateYml: "644", executable: "755", sandbox: "755" });
    expect(lstatSync(join(app, "link")).isSymbolicLink()).toBe(true);
    expect(normalizeTreeModes(root)).toBe(0);
  });

  // Each app's tests run its own afterPack on Linux (testing/linuxBuilderChecks.ts).
  it("withLinuxModes hands any other platform to the app's own hook", async () => {
    const hookDir = tmp();
    const hook = join(hookDir, "hook.mjs");
    writeFileSync(hook, "export default async (context) => { context.calls.push(context.electronPlatformName); };\n");
    const context = { electronPlatformName: "darwin", appOutDir: "/nonexistent", calls: [] as string[] };
    await withLinuxModes(hook)(context);
    log("darwin delegated", context.calls);
    expect(context.calls).toEqual(["darwin"]);
  });
});

// @req REL-DIST-13[badger-desktop,parrot] an update from an affected package drops the write bits on the folders it left 777
describe("after-install repair of earlier packages' folders (REL-DIST-13)", () => {
  // Each app's tests check that its .deb/.rpm/.pacman run the repair first (testing/linuxBuilderChecks.ts).
  it("the repair clears group/world write bits under the app folder and keeps chrome-sandbox setuid", () => {
    const root = tmp();
    writeUmask000Tree(root);
    const app = join(root, "opt", "Parrot");
    chmodSync(join(app, "chrome-sandbox"), 0o4755);
    const script = LEGACY_MODES_REPAIR.join("\n").replaceAll("'/opt/${sanitizedProductName}'", `'${app}'`);
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    const modes = {
      app: modeOf(app),
      resources: modeOf(join(app, "resources")),
      asar: modeOf(join(app, "resources", "app.asar")),
      executable: modeOf(join(app, "spaceparrot")),
      sandbox: modeOf(join(app, "chrome-sandbox")),
    };
    log("repaired", { status: run.status, stderr: run.stderr, modes });
    expect(run.status).toBe(0);
    expect(modes).toEqual({ app: "755", resources: "755", asar: "644", executable: "755", sandbox: "4755" });
  });
});

// @req REL-DIST-13[badger-desktop,parrot] the release fails on a package with a group/world-writable, setuid or setgid entry
describe("release guard on package file modes (REL-DIST-13)", () => {
  it("flags group/world-writable entries and setuid/setgid, never symlinks", () => {
    const cases = [
      { type: "file", mode: 0o644 },
      { type: "dir", mode: 0o755 },
      { type: "file", mode: 0o666 },
      { type: "dir", mode: 0o777 },
      { type: "file", mode: 0o664 },
      { type: "file", mode: 0o4755 },
      { type: "file", mode: 0o2755 },
      { type: "link", mode: 0o777 },
    ].map((entry) => ({ ...entry, reason: modeViolation(entry) }));
    log("violations", cases);
    expect(cases.map((entry) => entry.reason)).toEqual([
      null,
      null,
      "group-writable, world-writable",
      "group-writable, world-writable",
      "group-writable",
      "setuid",
      "setgid",
      null,
    ]);
  });

  it("reads bsdtar mtree and rpm header listings (what the .deb/.pacman and .rpm checks parse)", () => {
    // Shapes copied from the live Parrot-0.1.2 packages.
    const mtree = "#mtree\n./opt type=dir mode=755\n./opt/Parrot type=dir mode=777\n./opt/Parrot/resources/app.asar type=file mode=666\n./usr/share/applications/spaceparrot.desktop type=file mode=666\n./opt/Parrot/libEGL.so type=file mode=755\n./usr/bin/spaceparrot type=link mode=777\n";
    const rpm = "40755 /opt/Parrot\n100666 /opt/Parrot/resources/app.asar\n100755 /opt/Parrot/spaceparrot\n120777 /usr/bin/spaceparrot\n";
    const fromMtree = parseMtree(mtree);
    const fromRpm = parseRpmModes(rpm);
    log("mtree", fromMtree);
    log("rpm", fromRpm);
    expect(fromMtree.filter((entry) => modeViolation(entry)).map((entry) => entry.path)).toEqual([
      "/opt/Parrot",
      "/opt/Parrot/resources/app.asar",
      "/usr/share/applications/spaceparrot.desktop",
    ]);
    expect(fromRpm).toEqual([
      { path: "/opt/Parrot", type: "dir", mode: 0o755 },
      { path: "/opt/Parrot/resources/app.asar", type: "file", mode: 0o666 },
      { path: "/opt/Parrot/spaceparrot", type: "file", mode: 0o755 },
      { path: "/usr/bin/spaceparrot", type: "link", mode: 0o777 },
    ]);
    expect(packageModeViolations("x.rpm", () => fromRpm)).toEqual([
      { path: "/opt/Parrot/resources/app.asar", mode: "0666", reason: "group-writable, world-writable" },
    ]);
  });

  /** A .pacman (zstd tar with .PKGINFO) and a .deb (ar of debian-binary, control.tar.xz, data.tar.xz) of `tree`, built with bsdtar. */
  const buildPackages = (tree: string, out: string, name: string) => {
    const bsdtar = (args: string[], cwd: string) => {
      const result = spawnSync("bsdtar", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`bsdtar ${args.join(" ")}: ${result.stderr}`);
    };
    writeFileSync(join(tree, ".PKGINFO"), `pkgname = ${name}\n`);
    chmodSync(join(tree, ".PKGINFO"), 0o644);
    bsdtar(["--zstd", "-cf", join(out, `${name}.pacman`), ".PKGINFO", "opt"], tree);
    const meta = join(out, `${name}-deb`);
    mkdirSync(meta);
    writeFileSync(join(meta, "debian-binary"), "2.0\n");
    writeFileSync(join(meta, "control"), `Package: ${name}\n`);
    bsdtar(["-cJf", join(meta, "control.tar.xz"), "control"], meta);
    bsdtar(["-cJf", join(meta, "data.tar.xz"), "./opt"], tree);
    bsdtar(["--format=ar", "-cf", join(out, `${name}.deb`), "debian-binary", "control.tar.xz", "data.tar.xz"], meta);
    return [join(out, `${name}.deb`), join(out, `${name}.pacman`)];
  };

  // bsdtar is in the release job (packaging tools) and in every Linux packaging environment; a host without it cannot
  // build or read a .deb/.pacman at all.
  it.skipIf(spawnSync("sh", ["-c", "command -v bsdtar"], { stdio: "ignore" }).status !== 0)("check-package-modes.mjs fails on a umask-000 .deb and .pacman and passes on correct ones", () => {
    const out = tmp();
    const badTree = tmp();
    writeUmask000Tree(badTree);
    const goodTree = tmp();
    writeGoodTree(goodTree);
    const bad = buildPackages(badTree, out, "bad");
    const good = buildPackages(goodTree, out, "good");

    for (const file of bad) log(`entries ${file}`, listPackageEntries(file));
    expect(packageModeViolations(bad[1]).map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["/opt", "/opt/Parrot", "/opt/Parrot/resources", "/opt/Parrot/resources/app.asar", "/opt/Parrot/chrome-sandbox"]),
    );
    expect(packageModeViolations(bad[1]).some((entry) => entry.path === "/.PKGINFO")).toBe(false);

    const failing = spawnSync(process.execPath, [CHECK, ...bad], { encoding: "utf8" });
    log("guard on bad packages", { status: failing.status, stdout: failing.stdout, stderr: failing.stderr });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("0666 /opt/Parrot/resources/app.asar (group-writable, world-writable)");
    expect(failing.stderr).toContain("0777 /opt/Parrot (group-writable, world-writable)");
    expect(failing.stderr).toContain("4755 /opt/Parrot/chrome-sandbox (setuid)");
    expect(failing.stderr).toMatch(/FAIL .*bad\.deb/);
    expect(failing.stderr).toMatch(/FAIL .*bad\.pacman/);

    const passing = spawnSync(process.execPath, [CHECK, ...good], { encoding: "utf8" });
    log("guard on good packages", { status: passing.status, stdout: passing.stdout, stderr: passing.stderr });
    expect(passing.status).toBe(0);
    expect(passing.stdout).toMatch(/ok .*good\.deb/);
    expect(passing.stdout).toMatch(/ok .*good\.pacman/);
  });
});
