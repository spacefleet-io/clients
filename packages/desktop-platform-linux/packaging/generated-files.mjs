// The package scripts and files the Linux builds generate for an app (after-install, after-remove, the .rpm
// %posttrans, the system-update helper and its polkit policy) live under the app's node_modules/.cache, one copy per
// app. Every call of the app's electron-builder config rewrites them, and the app's tests call it from several vitest
// workers at once (linux-package-checks, linux-packages, tray-icons, update-feed, windows-test-build): writing in
// place truncated a file another worker was reading, which then read it empty (quick-checks run 55239). So each write
// goes to its own temporary file and is renamed over the old one: a reader sees the old file or the new one, whole.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes `content` to `<appDir>/node_modules/.cache/spacefleet-linux/<name>`, with `mode` when given, by an atomic
 * rename, and returns its path.
 * @param {string} appDir
 * @param {string} name
 * @param {string} content
 * @param {number} [mode]
 */
export const writeGeneratedFile = (appDir, name, content, mode) => {
  const path = join(appDir, "node_modules", ".cache", "spacefleet-linux", name);
  mkdirSync(dirname(path), { recursive: true });
  // unique per call, also across worker threads of one process
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
};
