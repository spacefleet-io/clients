// Reads a packaged app.asar's file list, for the post-package checks of both desktop apps' scripts/package.mjs.
import { readFileSync } from "node:fs";

/**
 * Every file path inside an asar archive. Reads only the JSON header: the file is a
 * Chromium pickle (u32 size, u32 header size, u32 json length, u32 json length, json).
 * @param {string} asarPath
 * @returns {string[]}
 */
export const listAsarEntries = (asarPath) => {
  const buffer = readFileSync(asarPath);
  const jsonLength = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString("utf8"));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`;
      if (child.files) walk(child, path);
      else entries.push(path.slice(1));
    }
  };
  walk(header, "");
  return entries;
};
