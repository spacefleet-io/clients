import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * @typedef {(path: string, options: { withFileTypes: true }) => import("node:fs").Dirent[]} ReaddirImpl
 * @typedef {{ path: string; bytes: number }} PackagedFile
 * @typedef {{ name: string; bytes: number; type: "dir" | "file" | "other" }} PackagedEntry
 */

/** @param {import("node:fs").Dirent[]} dirents @returns {import("node:fs").Dirent[]} */
const listEntriesSorted = (dirents) =>
  [...dirents].sort((a, b) => a.name.localeCompare(b.name));

/** @param {number} bytes @returns {string} */
export const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 1 : 2)} ${units[unitIndex]}`;
};

/** @param {string} rootDir @param {string} walkDir @param {ReaddirImpl} readdirSyncImpl @returns {PackagedFile[]} */
export const collectTopFiles = (rootDir, walkDir, readdirSyncImpl) => {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of listEntriesSorted(readdirSyncImpl(currentDir, { withFileTypes: true }))) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        path: relative(rootDir, absolutePath),
        bytes: statSync(absolutePath).size,
      });
    }
  };
  visit(walkDir);
  return files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
};

/** @param {string} targetPath @param {ReaddirImpl} readdirSyncImpl @returns {number} */
export const getPathSize = (targetPath, readdirSyncImpl) => {
  const linkStat = lstatSync(targetPath);
  if (linkStat.isSymbolicLink()) {
    try {
      const resolvedPath = realpathSync(targetPath);
      if (existsSync(resolvedPath)) {
        return statSync(resolvedPath).size;
      }
    } catch {
      return linkStat.size;
    }
    return linkStat.size;
  }
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of listEntriesSorted(readdirSyncImpl(targetPath, { withFileTypes: true }))) {
    total += getPathSize(join(targetPath, entry.name), readdirSyncImpl);
  }
  return total;
};

/** @param {string} dir @param {ReaddirImpl} readdirSyncImpl @returns {PackagedEntry[]} */
export const collectTopLevelEntries = (dir, readdirSyncImpl) =>
  listEntriesSorted(readdirSyncImpl(dir, { withFileTypes: true })).map((entry) => {
    const absolutePath = join(dir, entry.name);
    return {
      name: entry.name,
      bytes: getPathSize(absolutePath, readdirSyncImpl),
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    };
  });

/**
 * @param {{ appImageBytes: number; unpackedBytes: number; topLevelEntries: PackagedEntry[]; topFiles: PackagedFile[] }} sizes
 * @returns {string}
 */
export const formatReport = ({ appImageBytes, unpackedBytes, topLevelEntries, topFiles }) => {
  const lines = [
    `AppImage: ${formatBytes(appImageBytes)}`,
    `Unpacked: ${formatBytes(unpackedBytes)}`,
    "",
    "Top-level resources:",
    ...topLevelEntries.map((entry) => `- ${entry.name} (${entry.type}): ${formatBytes(entry.bytes)}`),
    "",
    "Largest packaged files:",
    ...topFiles.map((file) => `- ${file.path}: ${formatBytes(file.bytes)}`),
  ];
  return `${lines.join("\n")}\n`;
};
