/**
 * @req OFFL-AUTO-01
 *
 * The desktop app never starts an offline download by itself: the only code
 * path that reaches the runtime's `badger.offline.download.submit` command is
 * the confirm button of OfflineDownloadConfirmDialog. Nothing else in the main
 * process or the renderer (playback, library, launch, reconnect) may call it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

const filesMatching = (pattern: RegExp): string[] =>
  sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();

describe("desktop offline downloads are user-initiated only (OFFL-AUTO-01)", () => {
  it("only the confirm dialog calls the renderer download-submit helper", () => {
    expect(filesMatching(/callOfflineDownloadSubmit\(/)).toEqual([
      "renderer/src/components/OfflineDownloadConfirmDialog.tsx",
    ]);
  });

  it("only the offline IPC helper reaches the preload downloadSubmit bridge", () => {
    expect(filesMatching(/\.downloadSubmit\(/)).toEqual(["renderer/src/lib/offlineIpc.ts"]);
  });

  it("the dialog dispatches the submit only from its confirm button click", () => {
    const dialog = readFileSync(join(SRC, "renderer/src/components/OfflineDownloadConfirmDialog.tsx"), "utf8");
    const callIndex = dialog.indexOf("await callOfflineDownloadSubmit(");
    const submitDefinition = dialog.indexOf("const submit = async () =>");
    expect(submitDefinition).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(submitDefinition);
    // `submit` is referenced exactly twice: its definition and the onClick.
    const references = dialog.match(/\bsubmit\(\)/g) ?? [];
    expect(references).toHaveLength(1);
    expect(dialog).toContain("onClick={() => void submit()}");
  });
});
