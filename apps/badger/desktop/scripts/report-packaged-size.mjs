import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { collectTopFiles, collectTopLevelEntries, formatReport, getPathSize } from "./report-packaged-size-lib.mjs";

const appDir = resolve(import.meta.dirname, "..");
const distDir = resolve(appDir, "dist");
const unpackedDir = resolve(distDir, "linux-unpacked");
const resourcesDir = resolve(unpackedDir, "resources");
const { version } = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf8"));
const appImagePath = resolve(distDir, `@spacebadger-desktop-${version}.AppImage`);

const appImageBytes = statSync(appImagePath).size;
const unpackedBytes = getPathSize(unpackedDir, readdirSync);
const topLevelEntries = collectTopLevelEntries(resourcesDir, readdirSync).sort(
  (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)
);
const topFiles = collectTopFiles(resourcesDir, resourcesDir, readdirSync).slice(0, 50);

process.stdout.write(
  formatReport({
    appImageBytes,
    unpackedBytes,
    topLevelEntries,
    topFiles,
  })
);
