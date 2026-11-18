// File modes of the Linux packages (REL-DIST-13). The .deb, .rpm and .pacman install root-owned files under /opt and
// /usr; fpm copies the modes it finds, so a build whose umask is 000 (the CI job containers: every file the job
// writes is 666, every directory 777) ships files any local user can rewrite, app.asar included. Three parts:
//   - the build sets umask 022 and normalizes the packed app to u=rwX,go=rX (`normalizeTreeModes`, electron-builder
//     afterPack), so nothing depends on the runner;
//   - the release checks every built package (`packageModeViolations`, check-package-modes.mjs) and fails on any
//     group/world-writable entry or any setuid/setgid bit;
//   - the packages' after-install script drops the write bits an earlier, affected package left on folders that
//     already exist (`linuxAfterInstallScript`): dpkg and pacman keep such a folder's mode on update.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { builderLinuxTemplate, writeLinuxScript } from "./linux-packages.mjs";

/** The umask every Linux packaging run uses: files 644, directories 755. */
export const PACKAGING_UMASK = 0o022;

/** The `chmod u=rwX,go=rX` of one entry: 755 for a directory or anything with an execute bit, else 644. */
export const normalizedMode = (mode, isDirectory) => (isDirectory || (mode & 0o111) !== 0 ? 0o755 : 0o644);

/**
 * `chmod -R u=rwX,go=rX root`: every directory and executable 755, every other file 644, setuid/setgid/sticky cleared.
 * Symlinks are left alone (their mode means nothing). Returns how many entries changed.
 */
export const normalizeTreeModes = (root) => {
  let changed = 0;
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    const isDirectory = stat.isDirectory();
    const wanted = normalizedMode(stat.mode, isDirectory);
    if ((stat.mode & 0o7777) !== wanted) {
      chmodSync(path, wanted);
      changed += 1;
    }
    if (isDirectory) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
  return changed;
};

/**
 * electron-builder afterPack hook: on Linux, `normalizeTreeModes(appOutDir)` (the AppImage and fpm packages are built
 * from that tree next); on any other platform, the app's own hook at `hookPath` (macOS signing). The returned hook
 * carries `hookPath`, so a config test can still check which platform hook it runs.
 */
export const withLinuxModes = (hookPath) =>
  Object.assign(
    async (context) => {
      if (context.electronPlatformName === "linux") {
        const changed = normalizeTreeModes(context.appOutDir);
        console.log(`[linux-after-pack] ${context.appOutDir}: ${changed} entries set to u=rwX,go=rX (REL-DIST-13)`);
        return;
      }
      const { default: hook } = await import(pathToFileURL(hookPath).href);
      return hook(context);
    },
    { hookPath },
  );

/**
 * The lines the after-install script runs first (an electron-builder template: `${sanitizedProductName}` is the
 * /opt folder). Badger 0.1.0-0.1.1 and Parrot 0.1.0-0.1.2 created /opt/<Product>, its resources and locales (and
 * Badger's resources subfolders) 777; dpkg and pacman keep the mode of a folder that already exists, so without this
 * an update from those releases would leave them writable by anyone. `go-w` keeps chrome-sandbox's setuid bit.
 */
export const LEGACY_MODES_REPAIR = [
  "# REL-DIST-13: folders an earlier package left group/world-writable keep that mode on update (dpkg, pacman).",
  "chmod -R go-w '/opt/${sanitizedProductName}' || true",
];

/**
 * Writes the .deb/.rpm/.pacman after-install script for the app at `appDir` and returns its path (electron-builder
 * `afterInstall`): electron-builder's own script (the /usr/bin link, chrome-sandbox, AppArmor), read from the
 * electron-builder the app builds with, with `LEGACY_MODES_REPAIR` right after its shebang.
 */
export const linuxAfterInstallScript = (appDir) => {
  const { shebang, body } = builderLinuxTemplate(appDir, "after-install");
  return writeLinuxScript(appDir, "after-install.tpl", [shebang, ...LEGACY_MODES_REPAIR, ...body]);
};

/** @typedef {{ path: string; type: string; mode: number }} PackageEntry One installed path with its type and permission bits. */

/**
 * Why one packaged entry may not ship, or null. Symlinks are exempt (always 777, the target's mode applies).
 * @param {{ type: string; mode: number }} entry
 * @returns {string | null}
 */
export const modeViolation = ({ type, mode }) => {
  if (type === "link") return null;
  const reasons = [];
  if (mode & 0o020) reasons.push("group-writable");
  if (mode & 0o002) reasons.push("world-writable");
  if (mode & 0o4000) reasons.push("setuid");
  if (mode & 0o2000) reasons.push("setgid");
  return reasons.length > 0 ? reasons.join(", ") : null;
};

/**
 * Entries of a `bsdtar --format=mtree` listing (`./path type=file mode=644`). Paths keep mtree's escaping (`\040` for
 * a space), which is fine for a report.
 * @param {string} text
 * @returns {PackageEntry[]}
 */
export const parseMtree = (text) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("./"))
    .map((line) => {
      const [path, ...keywords] = line.trim().split(/\s+/);
      const fields = Object.fromEntries(keywords.map((keyword) => keyword.split("=")));
      if (fields.type === undefined || fields.mode === undefined) throw new Error(`mtree line without type/mode: ${line}`);
      return { path: path.slice(1) || "/", type: fields.type, mode: Number.parseInt(fields.mode, 8) };
    });

/**
 * Entries of `rpm -qp --qf '[%{FILEMODES:octal} %{FILENAMES}\n]'` (the header modes rpm installs with).
 * @param {string} text
 * @returns {PackageEntry[]}
 */
export const parseRpmModes = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*([0-7]+) (.+)$/.exec(line);
      if (!match) throw new Error(`unexpected rpm file line: ${line}`);
      const mode = Number.parseInt(match[1], 8);
      const format = mode & 0o170000;
      const type = format === 0o120000 ? "link" : format === 0o040000 ? "dir" : "file";
      return { path: match[2], type, mode: mode & 0o7777 };
    });

const run = (command, args, input) => {
  const result = spawnSync(command, args, { input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr.toString()}`);
  return result.stdout;
};

const MTREE_ARGS = ["-cf", "-", "--format=mtree", "--options=!all,type,mode"];

/**
 * What a package installs, with the modes it installs them with: the .deb data archive, the .pacman tree, the .rpm header.
 * @param {string} file
 * @returns {PackageEntry[]}
 */
export const listPackageEntries = (file) => {
  if (file.endsWith(".rpm")) {
    return parseRpmModes(run("rpm", ["-qp", "--nosignature", "--nodigest", "--qf", "[%{FILEMODES:octal} %{FILENAMES}\\n]", file]).toString());
  }
  if (file.endsWith(".deb")) {
    const members = run("bsdtar", ["-tf", file]).toString().split("\n");
    const data = members.find((name) => name.startsWith("data.tar"));
    if (!data) throw new Error(`${file} has no data.tar member`);
    const payload = run("bsdtar", ["-xOf", file, data]);
    return parseMtree(run("bsdtar", [...MTREE_ARGS, "@-"], payload).toString());
  }
  if (file.endsWith(".pacman") || file.endsWith(".pkg.tar.zst")) {
    // .PKGINFO, .MTREE and .INSTALL are pacman's metadata, not installed files.
    return parseMtree(run("bsdtar", [...MTREE_ARGS, `@${file}`]).toString()).filter((entry) => !/^\/\.[A-Z]+$/.test(entry.path));
  }
  throw new Error(`not a .deb, .rpm or .pacman package: ${file}`);
};

/**
 * Every entry of `file` that may not ship, as `{ path, mode, reason }` (mode in octal).
 * @param {string} file
 * @param {(file: string) => PackageEntry[]} [list]
 * @returns {{ path: string; mode: string; reason: string }[]}
 */
export const packageModeViolations = (file, list = listPackageEntries) =>
  list(file).flatMap((entry) => {
    const reason = modeViolation(entry);
    return reason ? [{ path: entry.path, mode: (entry.mode & 0o7777).toString(8).padStart(4, "0"), reason }] : [];
  });
