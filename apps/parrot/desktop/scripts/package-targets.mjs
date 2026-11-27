// The single table of Parrot packaging targets, read by scripts/package.mjs and electron-builder.config.mjs.
// Same shape and rules as apps/badger/desktop/scripts/package-targets.mjs, minus what Parrot does not ship: no
// runtime binary, no media-deps bundle (ffmpeg/mpv), no native module. Every target carries the in-app updater feed
// (REL-UPD-01: app-update.yml in the package, latest-*.yml next to the installers). Nothing here inspects the
// host: the target is always named (or defaults to DEFAULT_TARGET), so Linux cross-builds the Windows installer.

import { LINUX_FORMATS, linuxArtifactPatterns as sharedLinuxArtifactPatterns } from "../../../../packages/desktop-platform-linux/packaging/linux-packages.mjs";
import { ELECTRON_LANGUAGES, LPROJ_EXTENSION, MAC_ELECTRON_LANGUAGES, PAK_EXTENSION } from "../../../../packages/desktop-platform/packaging/packaged-locales-lib.mjs";

/**
 * Chromium locale files kept in the package: the languages of Parrot's own UI (en, fr, nl, de, es:
 * src/renderer/src/i18n.ts PARROT_STRINGS), the same list as Badger (packaged-locales-lib.mjs), Spanish twice
 * (es + es-419 / es_419.lproj): electron-builder's "es" keeps the es-419 file anyway, and Chromium needs it on
 * every Spanish system outside Spain.
 */
export { ELECTRON_LANGUAGES, MAC_ELECTRON_LANGUAGES };

/** PLAT-DESK-02: the oldest macOS the desktop apps run on (shared with Badger). */
export { MAC_MINIMUM_SYSTEM_VERSION } from "../../../../packages/desktop-platform-macos/packaging/mac-after-pack-lib.mjs";

/** Linux package formats (PLAT-DESK-01): one app, four formats, shared with Badger (packages/desktop-platform-linux/packaging/linux-packages.mjs). */
export { LINUX_FORMATS };

/** Product name on every target (PLAT-SUITE-02: the app is called Parrot; SpaceParrot is only the domain). */
export const PRODUCT_NAME = "Parrot";

/** Linux/macOS file names: `Parrot-<version>-<arch>.<ext>`; the .exe is `Parrot-Setup-<version>.exe`. */
const escapedName = PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @typedef {{
 *   id: string;
 *   builderFlag: string;
 *   arch: "x64" | "arm64";
 *   unpackedDir: string;
 *   resourcesSubpath: string;
 *   locales: { subpath: string; languages: string[]; extension: string };
 *   artifactPatterns: RegExp[];
 * }} PackageTarget
 */

/** @param {"arm64" | "x64"} arch @param {string} unpackedDir @returns {PackageTarget} */
function macTarget(arch, unpackedDir) {
  return {
    id: `macos-${arch}`,
    builderFlag: "--mac",
    arch,
    unpackedDir,
    resourcesSubpath: `${PRODUCT_NAME}.app/Contents/Resources`,
    locales: { subpath: `${PRODUCT_NAME}.app/Contents/Resources`, languages: MAC_ELECTRON_LANGUAGES, extension: LPROJ_EXTENSION },
    // REL-MAC-03 (as Badger): one dmg per arch, never universal (PLAT-DESK-05), plus the in-app update zip (the
    // notarized .app), its blockmap and this arch's latest-mac.yml (the release workflow merges both arches' feeds).
    artifactPatterns: [
      new RegExp(`^${escapedName}-.+-${arch}\\.dmg$`),
      new RegExp(`^${escapedName}-.+-${arch}-mac\\.zip$`),
      new RegExp(`^${escapedName}-.+-${arch}-mac\\.zip\\.blockmap$`),
      /^latest-mac\.yml$/,
    ],
  };
}

/** @type {Record<string, PackageTarget>} */
export const PACKAGE_TARGETS = {
  "linux-x64": {
    id: "linux-x64",
    builderFlag: "--linux",
    arch: "x64",
    unpackedDir: "linux-unpacked",
    resourcesSubpath: "resources",
    locales: { subpath: "locales", languages: ELECTRON_LANGUAGES, extension: PAK_EXTENSION },
    artifactPatterns: [...sharedLinuxArtifactPatterns(PRODUCT_NAME, LINUX_FORMATS), /^latest-linux\.yml$/],
  },
  "windows-x64": {
    id: "windows-x64",
    builderFlag: "--win",
    arch: "x64",
    unpackedDir: "win-unpacked",
    resourcesSubpath: "resources",
    locales: { subpath: "locales", languages: ELECTRON_LANGUAGES, extension: PAK_EXTENSION },
    artifactPatterns: [new RegExp(`^${escapedName}-Setup-.*\\.exe$`), /\.exe\.blockmap$/, /^latest\.yml$/],
  },
  "macos-arm64": macTarget("arm64", "mac-arm64"),
  "macos-x64": macTarget("x64", "mac"),
};

export const DEFAULT_TARGET = "linux-x64";

/** @param {string} [id] @returns {PackageTarget} */
export const resolvePackageTarget = (id = DEFAULT_TARGET) => {
  const target = PACKAGE_TARGETS[id];
  if (!target) throw new Error(`unknown package target "${id}" (known: ${Object.keys(PACKAGE_TARGETS).join(", ")})`);
  return target;
};

/**
 * The Linux formats to build: all of LINUX_FORMATS by default, or a comma-separated subset (`--linux-formats
 * AppImage,deb`, SF_LINUX_FORMATS): the native formats need host tools (missingLinuxPackageTools).
 * @param {string | undefined} value
 * @returns {string[]}
 */
export const resolveLinuxFormats = (value) => {
  const raw = value?.trim();
  if (!raw) return [...LINUX_FORMATS];
  const formats = raw.split(",").map((format) => format.trim()).filter(Boolean);
  const unknown = formats.filter((format) => !LINUX_FORMATS.includes(format));
  if (formats.length === 0 || unknown.length > 0) {
    throw new Error(`unknown Linux package format(s) "${unknown.join(", ") || raw}" (known: ${LINUX_FORMATS.join(", ")})`);
  }
  return [...new Set(formats)];
};

/** The artifact patterns a Linux build of `formats` must produce: one per format (shared with Badger) plus the feed. */
export const linuxArtifactPatterns = (formats) => [...sharedLinuxArtifactPatterns(PRODUCT_NAME, formats), /^latest-linux\.yml$/];

/** Files the packaged app.asar must hold: everything is bundled into out/ (electron.vite.config.ts), no node_modules. */
export const REQUIRED_ASAR_ENTRIES = ["package.json", "out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"];

/**
 * Entries of the packaged app.asar that must not ship (source maps, declarations, any node_modules: Parrot bundles
 * every dependency) and required ones that are absent.
 * @param {string[]} entries
 * @returns {{ unexpected: string[]; missing: string[] }}
 */
export const checkParrotAsarEntries = (entries) => {
  const normalized = entries.map((entry) => entry.replace(/^\/+/, ""));
  const unexpected = normalized.filter((path) => /\.(?:map|d\.ts|d\.cts|d\.mts)$/.test(path) || path.startsWith("node_modules/"));
  const present = new Set(normalized);
  return { unexpected, missing: REQUIRED_ASAR_ENTRIES.filter((entry) => !present.has(entry)) };
};
