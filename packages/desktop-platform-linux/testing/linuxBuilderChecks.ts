/**
 * The checks every app's electron-builder config passes for its .deb/.rpm/.pacman (REL-DIST-13, REL-DIST-14,
 * REL-UPD-07). Each app's own tests run them against its own config, so no package test reads an app's files; the
 * package's tests cover the scripts these checks find in the config.
 *
 * `linuxBuilderChecks` returns what it saw next to what it expects; the caller asserts each pair with its runner.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEGACY_MODES_REPAIR } from "../packaging/file-modes.mjs";
import { REMOVAL_ONLY } from "../packaging/linux-packages.mjs";

export type LinuxBuilderCheck = { check: string; actual: unknown; expected: unknown };
type Formats = Record<"deb" | "rpm" | "pacman", { afterInstall?: string; afterRemove?: string; fpm?: string[] }>;
type AfterPack = (context: { electronPlatformName: string; appOutDir: string }) => Promise<void>;

export const modeOf = (path: string) => (lstatSync(path).mode & 0o7777).toString(8);

/** The tree a umask-000 build leaves (what Parrot 0.1.2 shipped): 777 folders, 666 files, one 777 executable. */
export const writeUmask000Tree = (root: string) => {
  mkdirSync(join(root, "opt", "Parrot", "resources"), { recursive: true });
  writeFileSync(join(root, "opt", "Parrot", "resources", "app.asar"), "asar");
  writeFileSync(join(root, "opt", "Parrot", "resources", "app-update.yml"), "provider: generic\n");
  writeFileSync(join(root, "opt", "Parrot", "spaceparrot"), "#!/bin/sh\n");
  writeFileSync(join(root, "opt", "Parrot", "chrome-sandbox"), "elf");
  symlinkSync("spaceparrot", join(root, "opt", "Parrot", "link"));
  for (const dir of ["opt", "opt/Parrot", "opt/Parrot/resources"]) chmodSync(join(root, dir), 0o777);
  chmodSync(join(root, "opt", "Parrot", "resources", "app.asar"), 0o666);
  chmodSync(join(root, "opt", "Parrot", "resources", "app-update.yml"), 0o664);
  chmodSync(join(root, "opt", "Parrot", "spaceparrot"), 0o777);
  chmodSync(join(root, "opt", "Parrot", "chrome-sandbox"), 0o4755);
};

/** The one script the three formats share for `key`, read as lines. */
const sharedScript = (formats: Formats, key: "afterInstall" | "afterRemove") => {
  const paths = [...new Set([formats.deb[key], formats.rpm[key], formats.pacman[key]])];
  const [path] = paths;
  return { count: paths.length, lines: typeof path === "string" ? readFileSync(path, "utf8").split("\n") : [] };
};

/** REL-DIST-13: afterPack normalizes the packed app on Linux. */
const afterPackChecks = async (config: object, tmp: () => string): Promise<LinuxBuilderCheck[]> => {
  const afterPack = "afterPack" in config ? config.afterPack : undefined;
  if (typeof afterPack !== "function") return [{ check: "afterPack is a hook function", actual: typeof afterPack, expected: "function" }];
  const root = tmp();
  writeUmask000Tree(root);
  await (afterPack as AfterPack)({ electronPlatformName: "linux", appOutDir: root });
  return [
    {
      check: "afterPack on Linux normalizes the packed app (REL-DIST-13)",
      actual: { asar: modeOf(join(root, "opt", "Parrot", "resources", "app.asar")), dir: modeOf(join(root, "opt")) },
      expected: { asar: "644", dir: "755" },
    },
  ];
};

/** REL-DIST-13: after-install runs the legacy-modes repair before electron-builder's own steps. */
const afterInstallChecks = (formats: Formats): LinuxBuilderCheck[] => {
  const { count, lines } = sharedScript(formats, "afterInstall");
  const text = lines.join("\n");
  return [
    {
      check: "the .deb/.rpm/.pacman run one after-install script, the repair first, electron-builder's steps after (REL-DIST-13)",
      actual: { count, head: lines.slice(0, 3), chromeSandbox: text.includes("chrome-sandbox"), alternatives: text.includes("update-alternatives --install") },
      expected: { count: 1, head: ["#!/bin/bash", ...LEGACY_MODES_REPAIR], chromeSandbox: true, alternatives: true },
    },
  ];
};

/** REL-DIST-14: after-remove acts on a real removal only. */
const afterRemoveChecks = (formats: Formats): LinuxBuilderCheck[] => {
  const { count, lines } = sharedScript(formats, "afterRemove");
  return [
    {
      check: "the .deb/.rpm/.pacman run one after-remove script behind the removal check (REL-DIST-14)",
      actual: { count, head: lines.slice(0, REMOVAL_ONLY.length + 1), alternatives: lines.join("\n").includes("update-alternatives --remove") },
      expected: { count: 1, head: ["#!/bin/bash", ...REMOVAL_ONLY], alternatives: true },
    },
  ];
};

/** REL-DIST-14: the .rpm %posttrans relinks a missing /usr/bin/<package> and leaves a present one alone. */
const posttransChecks = (formats: Formats, packageName: string, tmp: () => string): LinuxBuilderCheck[] => {
  const fpm = formats.rpm.fpm ?? [];
  const path = fpm.includes("--rpm-posttrans") ? fpm[fpm.indexOf("--rpm-posttrans") + 1] : undefined;
  if (typeof path !== "string") return [{ check: "the .rpm has a --rpm-posttrans script", actual: false, expected: true }];
  const root = tmp();
  const bin = join(root, "usr-bin");
  const fakes = join(root, "fakes");
  mkdirSync(bin, { recursive: true });
  mkdirSync(fakes, { recursive: true });
  const calls = join(root, "calls");
  // rpm -ql lists the package's files; update-alternatives records its arguments and makes the link.
  writeFileSync(join(fakes, "rpm"), `#!/bin/sh\necho /opt/Product/resources/app.asar\necho /opt/Product/${packageName}\n`);
  writeFileSync(join(fakes, "update-alternatives"), `#!/bin/sh\necho "$@" >> '${calls}'\nln -sf "$5" "$2"\n`);
  for (const fake of ["rpm", "update-alternatives"]) chmodSync(join(fakes, fake), 0o755);
  const script = readFileSync(path, "utf8").replaceAll("/usr/bin/", `${bin}/`);
  const run = () => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${fakes}:/usr/bin:/bin` } });

  const missing = run();
  const recorded = existsSync(calls) ? readFileSync(calls, "utf8").trim() : "";
  if (existsSync(calls)) rmSync(calls);
  // unlinkSync, not rmSync: the fake leaves a dangling link, which Node 24's rmSync leaves in place
  if (lstatSync(join(bin, packageName), { throwIfNoEntry: false })) unlinkSync(join(bin, packageName));
  // a working link (a dangling one counts as missing and is relinked)
  symlinkSync(join(fakes, "rpm"), join(bin, packageName));
  const present = run();
  return [
    {
      check: "the .rpm %posttrans relinks a missing command through update-alternatives (REL-DIST-14)",
      actual: { status: missing.status, recorded },
      expected: { status: 0, recorded: `--install ${bin}/${packageName} ${packageName} /opt/Product/${packageName} 100` },
    },
    {
      check: "the .rpm %posttrans leaves a present command alone (REL-DIST-14)",
      actual: { status: present.status, called: existsSync(calls) },
      expected: { status: 0, called: false },
    },
  ];
};

/** REL-UPD-07: each format carries the package's own system-update helper and polkit policy last in fpm's arguments. */
const systemUpdateChecks = (formats: Formats, packageName: string): LinuxBuilderCheck[] =>
  (["deb", "rpm", "pacman"] as const).map((format) => {
    const tail = (formats[format].fpm ?? []).slice(-2);
    return {
      check: `the .${format} carries its own system-update helper and policy last in fpm's arguments (REL-UPD-07)`,
      actual: tail.map((arg) => arg.slice(arg.indexOf("=") + 1)),
      expected: [`/usr/lib/${packageName}/system-update`, `/usr/share/polkit-1/actions/io.spacefleet.${packageName}.update.policy`],
    };
  });

/** Runs every check against an app's Linux builder config; `packageName` is its .deb/.rpm/.pacman name. */
export const linuxBuilderChecks = async (config: object, packageName: string): Promise<LinuxBuilderCheck[]> => {
  const roots: string[] = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-linux-builder-checks-"));
    roots.push(dir);
    return dir;
  };
  try {
    const formats = config as unknown as Formats;
    return [
      ...(await afterPackChecks(config, tmp)),
      ...afterInstallChecks(formats),
      ...afterRemoveChecks(formats),
      ...posttransChecks(formats, packageName, tmp),
      ...systemUpdateChecks(formats, packageName),
    ];
  } finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  }
};
