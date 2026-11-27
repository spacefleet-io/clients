// Linux package formats shared by the Badger and Parrot desktop builds (PLAT-DESK-01, REL-FAM-02): which formats
// ship, how their files are named, and what each native package declares as dependencies.
//
// Every format carries the same app (PLAT-DESK-04): the native packages bundle exactly what the AppImage bundles
// (Badger's mpv/ffmpeg under <resources>/deps, RUNPATH=$ORIGIN), so only package metadata differs per format. The
// dependencies below are what the bundle leaves to the host on purpose (packages/media-deps/README.md "Host
// requirements") plus what Electron itself loads; electron-builder's own defaults miss libgbm and ALSA (Electron
// needs both) and, for pacman, name packages Arch no longer ships (http-parser, libappindicator-gtk3).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeGeneratedFile } from "./generated-files.mjs";
import { systemUpdateFpmFiles } from "./system-update.mjs";

/** The formats, in build order. AppImage first: electron-builder writes latest-linux.yml's top-level `path:` from the first one, and AppImage clients older than this list read that field. */
export const LINUX_FORMATS = ["AppImage", "deb", "rpm", "pacman"];

/** The native package formats (fpm), which install system-wide and update through the package manager (pkexec). */
export const NATIVE_LINUX_FORMATS = ["deb", "rpm", "pacman"];

/**
 * File name of every native package: `<Product>-<version>-<arch>.<ext>`, with electron-builder's arch token per
 * format (amd64 for .deb, x86_64 for .rpm, x64 for .pacman). The extension stays electron-builder's: electron-updater's
 * PacmanUpdater only picks a feed file ending in `.pacman` (not `.pkg.tar.zst`).
 */
export const NATIVE_PACKAGE_ARTIFACT_NAME = "${productName}-${version}-${arch}.${ext}";

/** What Electron loads from the host, per format (package names; rpm by soname so Fedora and openSUSE both resolve). */
const ELECTRON_DEPENDS = {
  deb: [
    "libgtk-3-0 | libgtk-3-0t64",
    "libnotify4",
    "libnss3",
    "libxss1",
    "libxtst6",
    "xdg-utils",
    "libatspi2.0-0 | libatspi2.0-0t64",
    "libuuid1",
    "libsecret-1-0",
    "libgbm1",
    // t64 first: on Ubuntu 24.04 `libasound2` is only a virtual name, and apt then picks liboss4-salsa-asound2,
    // which lacks ALSA_0.9 symbols Electron needs (`undefined symbol: snd_device_name_get_hint`).
    "libasound2t64 | libasound2",
  ],
  rpm: [
    "gtk3",
    "libnotify",
    "nss",
    "libXScrnSaver",
    "(libXtst or libXtst6)",
    "xdg-utils",
    "at-spi2-core",
    "(libuuid or libuuid1)",
    "libgbm.so.1()(64bit)",
    "libasound.so.2()(64bit)",
  ],
  pacman: ["gtk3", "nss", "libnotify", "libxss", "libxtst", "xdg-utils", "at-spi2-core", "util-linux-libs", "libsecret", "alsa-lib", "mesa"],
};

/**
 * What Badger's bundled mpv/ffmpeg leave to the host (the NEEDED sonames outside the bundle: GL/EGL, DRM, X11/xcb,
 * xkbcommon (MPV-GPU-04 Wayland keyboard), the text stack, ALSA, D-Bus, zlib). libwayland is bundled (media-deps
 * hostLibraries). Most already come with Electron's dependencies; they are named anyway so a package never relies
 * on that by accident. pacman leaves xkbcommon out: gtk3 pulls `libxkbcommon`, and the AUR packages'
 * `_release_depends` must match the released list.
 */
const MPV_HOST_DEPENDS = {
  deb: [
    "libegl1",
    "libx11-xcb1",
    "libxcb-dri3-0",
    "libxkbcommon0",
    "libdrm2",
    "libfontconfig1",
    "libfreetype6",
    "libfribidi0",
    "libharfbuzz0b",
    "libdbus-1-3",
    "zlib1g",
  ],
  rpm: [
    "libEGL.so.1()(64bit)",
    "libX11-xcb.so.1()(64bit)",
    "libxcb-dri3.so.0()(64bit)",
    "libxkbcommon.so.0()(64bit)",
    "libdrm.so.2()(64bit)",
    "libfontconfig.so.1()(64bit)",
    "libfreetype.so.6()(64bit)",
    "libfribidi.so.0()(64bit)",
    "libharfbuzz.so.0()(64bit)",
    "libdbus-1.so.3()(64bit)",
    "libz.so.1()(64bit)",
  ],
  pacman: ["libglvnd", "libx11", "libxcb", "libdrm", "fontconfig", "freetype2", "fribidi", "harfbuzz", "dbus", "zlib"],
};

/**
 * REL-DIST-14: how a renamed package takes over from the package name it replaced (`badger` -> `spacebadger`,
 * `parrot` -> `spaceparrot`), as fpm arguments per format. Only versions below 1 are ours: Debian and Ubuntu ship
 * their own `badger` 2.x (BadgerDB), which must never be removed or stood in for. So the .deb has no Provides (an
 * unversioned dependency on Debian's badger would accept ours); the .rpm writes `--replaces` as Obsoletes.
 */
export const legacyPackageRelations = (format, legacyName, version) =>
  ({
    deb: ["--conflicts", `${legacyName} (<< 1)`, "--replaces", `${legacyName} (<< 1)`],
    rpm: ["--replaces", `${legacyName} < 1`, "--provides", `${legacyName} = ${version}`],
    pacman: ["--conflicts", `${legacyName}<1`, "--replaces", `${legacyName}<1`, "--provides", `${legacyName}=${version}`],
  })[format];

/**
 * electron-builder's own Linux package script `templates/linux/<name>.tpl`, read from the electron-builder the app at
 * `appDir` builds with, as `{ shebang, body }` (body: the lines after the shebang).
 */
export const builderLinuxTemplate = (appDir, name) => {
  const builderPackage = createRequire(join(appDir, "package.json")).resolve("electron-builder/package.json");
  const template = readFileSync(createRequire(builderPackage).resolve(`app-builder-lib/templates/linux/${name}.tpl`), "utf8");
  const [shebang, ...body] = template.split("\n");
  if (!shebang.startsWith("#!")) throw new Error(`electron-builder's ${name}.tpl has no shebang: ${shebang}`);
  return { shebang, body };
};

/** Writes a generated package script for the app at `appDir` (under its node_modules/.cache, atomically) and returns its path. */
export const writeLinuxScript = (appDir, name, lines) => writeGeneratedFile(appDir, name, lines.join("\n"));

/**
 * REL-DIST-14: the lines the after-remove script runs first, so only a real removal drops the /usr/bin link and the
 * AppArmor profile. On an update rpm runs the old package's %postun (`$1` = 1 or more) after the new package's %post,
 * and dpkg runs the old postrm with `upgrade`, `failed-upgrade` or `abort-*`; electron-builder's script acts on every
 * call, which removed the command the new version had just linked. pacman passes the old version (`post_remove`),
 * rpm `0` on erase, dpkg `remove`/`purge`: those go on.
 */
export const REMOVAL_ONLY = [
  "# REL-DIST-14: on an update (rpm $1 >= 1, dpkg upgrade/failed-upgrade/abort-*) the new version keeps its command.",
  'case "$1" in',
  "  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear) exit 0 ;;",
  "  ''|0|*[!0-9]*) ;;",
  "  *) exit 0 ;;",
  "esac",
];

/** The .deb/.rpm/.pacman after-remove script (electron-builder `afterRemove`): electron-builder's own, behind `REMOVAL_ONLY`. */
export const linuxAfterRemoveScript = (appDir) => {
  const { shebang, body } = builderLinuxTemplate(appDir, "after-remove");
  return writeLinuxScript(appDir, "after-remove.tpl", [shebang, ...REMOVAL_ONLY, ...body]);
};

/**
 * REL-DIST-14: the .rpm %posttrans script (fpm `--rpm-posttrans`), which runs after the whole transaction. Badger
 * 0.1.0-0.1.1 and Parrot 0.1.0-0.1.2 (and any rpm built before `REMOVAL_ONLY`) drop `/usr/bin/<packageName>` in their
 * %postun, which runs after this package's %post on an update; this puts the link back. The executable is named like
 * the package (`spacebadger`, `spaceparrot`) and lives in the package's /opt/<Product> folder.
 */
export const rpmPosttransScript = (appDir, packageName) =>
  writeLinuxScript(appDir, "rpm-posttrans.sh", [
    "#!/bin/bash",
    "# REL-DIST-14: an earlier package's %postun may have removed the command after this package linked it.",
    `exe='${packageName}'`,
    '[ -e "/usr/bin/$exe" ] && exit 0',
    `bin=$(rpm -ql '${packageName}' 2>/dev/null | grep -m1 "^/opt/[^/]*/$exe\\$")`,
    '[ -n "$bin" ] || exit 0',
    "if type update-alternatives >/dev/null 2>&1; then",
    '  update-alternatives --install "/usr/bin/$exe" "$exe" "$bin" 100 || ln -sf "$bin" "/usr/bin/$exe"',
    "else",
    '  ln -sf "$bin" "/usr/bin/$exe"',
    "fi",
    "",
  ]);

/**
 * REL-DIST-14: rpmbuild's `/usr/lib/.build-id/<xx>/<id>` links, off. Badger and Parrot ship the same Electron binaries
 * (chrome_crashpad_handler, libEGL.so, ...), so both packages would own identical build-id links and rpm refuses to
 * install them together ("conflicts between attempted installs"). The links only serve debuginfo lookups, which our
 * packages don't have.
 */
export const RPM_FPM_NO_BUILD_ID_LINKS = ["--rpm-rpmbuild-define", "_build_id_links none"];

/**
 * electron-builder options for the native formats: one `<format>: { packageName, depends, artifactName, fpm,
 * afterInstall, afterRemove }` entry each (electron-builder takes `packageName` per format only, not under `linux`).
 * @param {{ appDir: string; packageName: string; productName: string; legacyName: string; version: string; mpv: boolean; afterInstall: string }} options
 *   `appDir`: the app's folder (the generated scripts go under its node_modules/.cache); `packageName`: the lower-case
 *   package name, also the executable (`spacebadger`, `spaceparrot`, REL-DIST-14); `legacyName`: the name the app's
 *   packages had before 0.1.2/0.1.3 (`badger`, `parrot`), taken over through `legacyPackageRelations`; `version`: the
 *   app version; `mpv`: the app bundles Badger's mpv/ffmpeg (adds MPV_HOST_DEPENDS); `afterInstall`: the
 *   after-install script (file-modes.mjs `linuxAfterInstallScript`, REL-DIST-13); `productName`: the name the update
 *   password dialog shows ("Badger", REL-UPD-07)
 *
 * REL-UPD-07: every native package also carries its root update helper and polkit action (system-update.mjs). They go
 * last in `fpm`: they are source=destination paths, and electron-builder appends the app's own paths after them.
 */
export const nativeLinuxPackageOptions = ({ appDir, packageName, productName, legacyName, version, mpv, afterInstall }) => {
  const afterRemove = linuxAfterRemoveScript(appDir);
  const posttrans = rpmPosttransScript(appDir, packageName);
  const updateFiles = systemUpdateFpmFiles({ appDir, packageName, productName });
  return Object.fromEntries(
    NATIVE_LINUX_FORMATS.map((format) => [
      format,
      {
        packageName,
        depends: [...ELECTRON_DEPENDS[format], ...(mpv ? MPV_HOST_DEPENDS[format] : [])],
        artifactName: NATIVE_PACKAGE_ARTIFACT_NAME,
        fpm: [
          ...legacyPackageRelations(format, legacyName, version),
          ...(format === "rpm" ? ["--rpm-posttrans", posttrans, ...RPM_FPM_NO_BUILD_ID_LINKS] : []),
          ...updateFiles,
        ],
        afterInstall,
        afterRemove,
      },
    ]),
  );
};

/**
 * One artifact pattern per format a Linux build must produce. AppImage keeps its existing name (`<Product>-<version>.AppImage`
 * for Badger, whose installed AppImages update in place by that name).
 * @param {string} productName
 * @param {string[]} [formats]
 * @returns {RegExp[]}
 */
export const linuxArtifactPatterns = (productName, formats = LINUX_FORMATS) =>
  formats.map((format) => new RegExp(`^${productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-.+\\.${format}$`));

/**
 * Host tools fpm shells out to per format: rpmbuild (.rpm), `tar -J` + `ar` (.deb, xz control archive), `tar --zstd`
 * + bsdtar (.pacman, zstd payload + .MTREE). The spacefleet-ci image has none of them; a build checks up front
 * instead of failing minutes into electron-builder.
 */
const FORMAT_TOOLS = { deb: ["xz", "ar"], rpm: ["rpmbuild"], pacman: ["zstd", "bsdtar"] };

/** Debian package that provides each tool (what the CI job installs). */
export const LINUX_TOOL_PACKAGES = { xz: "xz-utils", ar: "binutils", rpmbuild: "rpm", zstd: "zstd", bsdtar: "libarchive-tools" };

/**
 * Tools a build of `formats` needs that `has(tool)` says are missing.
 * @param {string[]} formats
 * @param {(tool: string) => boolean} has
 * @returns {string[]}
 */
export const missingLinuxPackageTools = (formats, has) =>
  [...new Set(formats.flatMap((format) => FORMAT_TOOLS[format] ?? []))].filter((tool) => !has(tool));
