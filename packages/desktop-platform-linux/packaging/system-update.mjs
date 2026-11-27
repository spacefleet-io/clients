// REL-UPD-07: the root side of "update only this app through the system's package manager", shipped in every
// .deb/.rpm/.pacman of Badger and Parrot (never in the AppImage or the Flatpak).
//
//  - `/usr/lib/<package>/system-update`: a root-owned script that takes NO argument. pkexec runs it as root after the
//    desktop's own password dialog; it finds which package manager owns it, refreshes SpaceFleet's repository alone
//    and updates the one package it is named after. It never upgrades anything else: on pacman and APT it first asks
//    the package manager what the update would install and refuses when that list upgrades another installed package;
//    on dnf and zypper only SpaceFleet's repository is enabled for the call, so nothing else can be picked.
//  - `/usr/share/polkit-1/actions/io.spacefleet.<package>.update.policy`: the polkit action naming that one program
//    (`org.freedesktop.policykit.exec.path`), so the password dialog reads "Update Badger" rather than a raw command.
//
// The app (packages/desktop-shell/src/updater/systemPackage.ts) reads the exit code; the table below is mirrored there
// as SYSTEM_UPDATE_EXIT and a test keeps the two equal.

import { writeGeneratedFile } from "./generated-files.mjs";

/** Exit codes of the helper (pkexec itself answers 126 when the dialog is dismissed and 127 when it cannot ask). */
export const SYSTEM_UPDATE_EXIT = {
  updated: 0,
  /** The repository has no newer version than the installed one (nothing changed). */
  notNewer: 10,
  /** SpaceFleet's repository is not configured on this system (the package came from a downloaded file). */
  repoMissing: 11,
  /** The update would also upgrade another installed package: the user updates the system first. */
  needsSystemUpdate: 12,
  /** The package manager failed (network, signature, lock held by another update…); its message is on stderr. */
  packageManager: 13,
  usage: 64,
  /** No known package manager owns the helper as `<package>`. */
  notManaged: 69,
  notRoot: 77,
};

/** Lower-case package names only: they end up inside a root script and a polkit file. */
const PACKAGE_NAME = /^[a-z][a-z0-9-]{1,40}$/;
/** Product names as shown in the dialog ("Badger", "Parrot"). */
const PRODUCT_NAME = /^[A-Z][A-Za-z]{1,30}$/;

const checkNames = (packageName, productName) => {
  if (!PACKAGE_NAME.test(packageName)) throw new Error(`system-update: bad package name ${JSON.stringify(packageName)}`);
  if (productName !== undefined && !PRODUCT_NAME.test(productName)) throw new Error(`system-update: bad product name ${JSON.stringify(productName)}`);
};

/** Where the helper is installed: one per package, so Badger and Parrot never own the same file. */
export const systemUpdateHelperPath = (packageName) => {
  checkNames(packageName);
  return `/usr/lib/${packageName}/system-update`;
};

/** The polkit action id of the helper. */
export const systemUpdateActionId = (packageName) => {
  checkNames(packageName);
  return `io.spacefleet.${packageName}.update`;
};

/** The SpaceFleet repository host the installer configures (packages/shared/src/linuxInstall.ts). */
const REPO_HOST = "https://packages.spacefleet.io";

/**
 * The helper script's lines. POSIX sh, run by pkexec as root with pkexec's clean environment; it reads no argument,
 * no environment variable and no file the user can write, and sets its own PATH and locale.
 * @param {string} packageName
 * @returns {string[]}
 */
export const systemUpdateHelperLines = (packageName) => {
  const self = systemUpdateHelperPath(packageName);
  const x = SYSTEM_UPDATE_EXIT;
  return [
    "#!/bin/sh",
    `# REL-UPD-07: updates the ${packageName} package, and nothing else, through this system's package manager.`,
    `# Run as root by pkexec (polkit action ${systemUpdateActionId(packageName)}); takes no arguments.`,
    `# Exit codes: ${x.updated} updated, ${x.notNewer} no newer version in the repository, ${x.repoMissing} SpaceFleet repository not configured,`,
    `# ${x.needsSystemUpdate} would upgrade other packages, ${x.packageManager} package manager failed, ${x.usage} arguments given,`,
    `# ${x.notManaged} not owned by a known package manager, ${x.notRoot} not root.`,
    "set -u",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "export PATH",
    "LC_ALL=C",
    "export LC_ALL",
    "unset LANGUAGE",
    "umask 022",
    `pkg='${packageName}'`,
    `self='${self}'`,
    `host='${REPO_HOST}'`,
    "work=",
    "cleanup() { [ -z \"$work\" ] || rm -rf \"$work\"; }",
    "trap cleanup EXIT",
    "say() { printf '[system-update] %s\\n' \"$*\" >&2; }",
    "finish() { code=$1; shift; say \"$*\"; printf 'SF_SYSTEM_UPDATE=%s\\n' \"$code\"; exit \"$code\"; }",
    `[ "$#" -eq 0 ] || finish ${x.usage} "takes no arguments"`,
    `[ "$(id -u)" -eq 0 ] || finish ${x.notRoot} "must run as root: pkexec $self"`,
    "",
    "mgr=",
    "if command -v pacman >/dev/null 2>&1 && [ \"$(pacman -Qqo \"$self\" 2>/dev/null)\" = \"$pkg\" ]; then",
    "  mgr=pacman",
    "elif command -v dpkg-query >/dev/null 2>&1 && dpkg-query -S \"$self\" 2>/dev/null | grep -q \"^$pkg: \"; then",
    "  mgr=deb",
    "elif command -v rpm >/dev/null 2>&1 && [ \"$(rpm -qf --qf '%{NAME}' \"$self\" 2>/dev/null)\" = \"$pkg\" ]; then",
    "  mgr=rpm",
    "else",
    `  finish ${x.notManaged} "$self is not part of the $pkg package of pacman, dpkg or rpm"`,
    "fi",
    "",
    "installed() {",
    "  case $mgr in",
    "  pacman) pacman -Q \"$pkg\" 2>/dev/null | cut -d' ' -f2 ;;",
    "  deb) dpkg-query -W -f='${Version}' \"$pkg\" 2>/dev/null ;;",
    "  rpm) rpm -q --qf '%{VERSION}-%{RELEASE}' \"$pkg\" 2>/dev/null ;;",
    "  esac",
    "}",
    "",
    "# pacman: never -Syu, never a plain -Sy (refreshing every package list without upgrading is a partial upgrade).",
    "# SpaceFleet's list alone is refreshed through a configuration naming only [spacefleet] (same database, keyring",
    "# and signature requirement), then pacman resolves the update against the lists this system already has, the way",
    "# the installer does.",
    "update_pacman() {",
    `  grep -qxF '[spacefleet]' /etc/pacman.conf || finish ${x.repoMissing} "SpaceFleet's [spacefleet] repository is not in /etc/pacman.conf"`,
    `  work=$(mktemp -d) || finish ${x.packageManager} "mktemp failed"`,
    "  dbpath=$(pacman-conf DBPath 2>/dev/null) || dbpath=/var/lib/pacman/",
    "  gpgdir=$(pacman-conf GPGDir 2>/dev/null) || gpgdir=/etc/pacman.d/gnupg/",
    "  arch=$(uname -m)",
    "  server=$(pacman-conf --repo=spacefleet Server 2>/dev/null | head -n 1)",
    "  [ -n \"$server\" ] || server=\"$host/arch/$arch\"",
    "  printf '[options]\\nDBPath = %s\\nGPGDir = %s\\nArchitecture = %s\\n\\n[spacefleet]\\nSigLevel = Required DatabaseRequired\\nServer = %s\\n' \\",
    "    \"$dbpath\" \"$gpgdir\" \"$arch\" \"$server\" >\"$work/pacman.conf\"",
    "  say \"refreshing SpaceFleet's package list only ($server)\"",
    `  pacman -Sy --config "$work/pacman.conf" >&2 || finish ${x.packageManager} "could not read SpaceFleet's pacman repository"`,
    `  plan=$(pacman -Sp --needed --print-format '%n' "spacefleet/$pkg") || finish ${x.needsSystemUpdate} "$pkg needs packages newer than this system's package lists know"`,
    "  others=",
    "  for p in $plan; do",
    "    [ \"$p\" = \"$pkg\" ] && continue",
    "    if pacman -Q \"$p\" >/dev/null 2>&1; then others=\"$others $p\"; fi",
    "  done",
    `  [ -z "$others" ] || finish ${x.needsSystemUpdate} "updating $pkg would also upgrade:$others"`,
    `  pacman -S --needed --noconfirm "spacefleet/$pkg" >&2 || finish ${x.packageManager} "pacman could not update $pkg"`,
    "}",
    "",
    "# APT: SpaceFleet's source list alone is refreshed (the other lists are kept), then a dry run must upgrade no",
    "# installed package but this one.",
    "update_deb() {",
    "  list=sources.list.d/spacefleet.list",
    `  [ -f "/etc/apt/$list" ] || finish ${x.repoMissing} "SpaceFleet's APT source /etc/apt/$list is missing"`,
    "  say \"refreshing SpaceFleet's package list only (/etc/apt/$list)\"",
    "  apt-get update -o Dir::Etc::sourcelist=\"$list\" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >&2 ||",
    `    finish ${x.packageManager} "could not read SpaceFleet's APT repository"`,
    `  plan=$(apt-get -s install --only-upgrade "$pkg" 2>&1) || finish ${x.needsSystemUpdate} "apt cannot update $pkg on this system as it is: $(printf '%s' "$plan" | tail -n 3)"`,
    "  others=$(printf '%s\\n' \"$plan\" | awk -v p=\"$pkg\" '$1 == \"Inst\" && $2 != p && $3 ~ /^\\[/ { printf \" %s\", $2 }')",
    `  [ -z "$others" ] || finish ${x.needsSystemUpdate} "updating $pkg would also upgrade:$others"`,
    "  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --only-upgrade -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \"$pkg\" >&2 ||",
    `    finish ${x.packageManager} "apt-get could not update $pkg"`,
    "}",
    "",
    "# dnf / zypper: only SpaceFleet's repository is enabled for the call, so no other package can be picked.",
    "update_rpm() {",
    "  if command -v dnf >/dev/null 2>&1; then",
    `    [ -f /etc/yum.repos.d/spacefleet.repo ] || finish ${x.repoMissing} "SpaceFleet's repository /etc/yum.repos.d/spacefleet.repo is missing"`,
    "    say \"updating $pkg from SpaceFleet's repository only (dnf --repo=spacefleet)\"",
    `    dnf -y --refresh --repo=spacefleet --setopt=spacefleet.skip_if_unavailable=False upgrade "$pkg" >&2 || finish ${x.packageManager} "dnf could not update $pkg"`,
    "  elif command -v zypper >/dev/null 2>&1; then",
    `    zypper --non-interactive repos 2>/dev/null | grep -qw spacefleet || finish ${x.repoMissing} "SpaceFleet's zypper repository is missing"`,
    "    say \"updating $pkg from SpaceFleet's repository only (zypper --repo spacefleet)\"",
    `    zypper --non-interactive refresh spacefleet >&2 || finish ${x.packageManager} "could not read SpaceFleet's zypper repository"`,
    `    zypper --non-interactive update --repo spacefleet "$pkg" >&2 || finish ${x.packageManager} "zypper could not update $pkg"`,
    "  else",
    `    finish ${x.notManaged} "neither dnf nor zypper is installed"`,
    "  fi",
    "}",
    "",
    "before=$(installed)",
    "say \"$pkg $before installed ($mgr)\"",
    "update_$mgr",
    "after=$(installed)",
    `[ "$after" != "$before" ] || finish ${x.notNewer} "$pkg $before is already the newest version in SpaceFleet's repository"`,
    "say \"updated $pkg $before -> $after\"",
    `printf 'SF_SYSTEM_UPDATE=${x.updated} before=%s after=%s\\n' "$before" "$after"`,
    `exit ${x.updated}`,
    "",
  ];
};

/** The dialog's title and sentence per app language (polkit picks by the session's locale; Badger/Parrot untranslated). */
const POLICY_TEXT = {
  en: { description: "Update {app}", message: "Authentication is required to update {app} through the system's package manager." },
  fr: { description: "Mettre à jour {app}", message: "Une authentification est nécessaire pour mettre à jour {app} avec le gestionnaire de paquets du système." },
  nl: { description: "{app} bijwerken", message: "Authenticatie is vereist om {app} bij te werken via het pakketbeheer van het systeem." },
  de: { description: "{app} aktualisieren", message: "Zum Aktualisieren von {app} über die Paketverwaltung des Systems ist eine Authentifizierung nötig." },
  es: { description: "Actualizar {app}", message: "Se necesita autenticación para actualizar {app} con el gestor de paquetes del sistema." },
};

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The polkit action file: an administrator's password every time (auth_admin, never kept), for this one program.
 * @param {string} packageName
 * @param {string} productName
 * @returns {string}
 */
export const systemUpdatePolicy = (packageName, productName) => {
  checkNames(packageName, productName);
  const lines = (field, indent) =>
    Object.entries(POLICY_TEXT).map(([lang, text]) => {
      const value = xml(text[field].replace("{app}", productName));
      return lang === "en" ? `${indent}<${field}>${value}</${field}>` : `${indent}<${field} xml:lang="${lang}">${value}</${field}>`;
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">',
    `<!-- REL-UPD-07: lets ${productName} update its own ${packageName} package, and only that, after an administrator password. -->`,
    "<policyconfig>",
    "  <vendor>SpaceFleet</vendor>",
    "  <vendor_url>https://spacefleet.io</vendor_url>",
    `  <icon_name>${packageName}</icon_name>`,
    `  <action id="${systemUpdateActionId(packageName)}">`,
    ...lines("description", "    "),
    ...lines("message", "    "),
    "    <defaults>",
    "      <allow_any>auth_admin</allow_any>",
    "      <allow_inactive>auth_admin</allow_inactive>",
    "      <allow_active>auth_admin</allow_active>",
    "    </defaults>",
    `    <annotate key="org.freedesktop.policykit.exec.path">${systemUpdateHelperPath(packageName)}</annotate>`,
    "  </action>",
    "</policyconfig>",
    "",
  ].join("\n");
};

/**
 * fpm source=destination arguments that add the helper (0755) and the polkit action (0644) to a native package.
 * The files are generated under the app's node_modules/.cache with their final modes (fpm keeps the source mode).
 * @param {{ appDir: string; packageName: string; productName: string }} options
 * @returns {string[]}
 */
export const systemUpdateFpmFiles = ({ appDir, packageName, productName }) => {
  const helper = writeGeneratedFile(appDir, `${packageName}-system-update`, systemUpdateHelperLines(packageName).join("\n"), 0o755);
  const policy = writeGeneratedFile(appDir, `${systemUpdateActionId(packageName)}.policy`, systemUpdatePolicy(packageName, productName), 0o644);
  return [
    `${helper}=${systemUpdateHelperPath(packageName)}`,
    `${policy}=/usr/share/polkit-1/actions/${systemUpdateActionId(packageName)}.policy`,
  ];
};
