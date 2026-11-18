import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectTopFiles,
  collectTopLevelEntries,
  formatBytes,
  formatReport,
  getPathSize,
} from "../scripts/report-packaged-size-lib.mjs";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

// Dump-on-failure helper: surfaces the computed entries vs expectation so a
// ranking/sizing regression is diagnosable offline. try/catch-guarded.
const dumpSizeSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [report-packaged-size:${label}] size-report snapshot ===`);
    for (const [name, value] of Object.entries(ctx)) {
      console.error(`${name}=${JSON.stringify(value, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("packaged size reporting", () => {
  it("formats bytes in stable human-readable units", () => {
    expect(formatBytes(133)).toBe("133 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MiB");
  });

  it("ranks top-level entries and packaged files deterministically", () => {
    console.info("[report-packaged-size:setup] building fixture tree (ffmpeg 8B, mpv 4B, icon 2B)");
    root = mkdtempSync(join(tmpdir(), "desktop-size-report-"));
    const resourcesDir = join(root, "resources");
    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(join(resourcesDir, "ffmpeg"));
    mkdirSync(join(resourcesDir, "mpv"));
    writeFileSync(join(resourcesDir, "ffmpeg", "ffmpeg"), Buffer.alloc(8));
    writeFileSync(join(resourcesDir, "mpv", "mpv"), Buffer.alloc(4));
    writeFileSync(join(resourcesDir, "icon.png"), Buffer.alloc(2));

    const topLevel = collectTopLevelEntries(resourcesDir, readdirSync);
    const topFiles = collectTopFiles(resourcesDir, resourcesDir, readdirSync);
    console.info(
      `[report-packaged-size:collect] topFiles=${JSON.stringify(topFiles.map((e) => e.path))} topLevel=${JSON.stringify(topLevel.map((e) => e.name))}`,
    );

    const topFilePaths = topFiles.map((entry) => entry.path);
    const expectedTopFiles = ["ffmpeg/ffmpeg", "mpv/mpv", "icon.png"];
    const expectedTopLevel = [
      { name: "ffmpeg", bytes: 8, type: "dir" },
      { name: "icon.png", bytes: 2, type: "file" },
      { name: "mpv", bytes: 4, type: "dir" },
    ];
    if (
      JSON.stringify(topFilePaths) !== JSON.stringify(expectedTopFiles) ||
      JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)
    ) {
      dumpSizeSnapshot("ranking-mismatch", { topFiles, topLevel, expectedTopFiles, expectedTopLevel });
    }
    expect(topFilePaths).toEqual(expectedTopFiles);
    expect(topLevel).toEqual(expectedTopLevel);

    const report = formatReport({
      appImageBytes: 16,
      unpackedBytes: 32,
      topLevelEntries: topLevel,
      topFiles: topFiles.slice(0, 3),
    });
    console.info(`[report-packaged-size:report] generated report (${report.length} chars)`);

    if (
      !report.includes("AppImage: 16 B") ||
      !report.includes("Unpacked: 32 B") ||
      !report.includes("- ffmpeg/ffmpeg: 8 B")
    ) {
      dumpSizeSnapshot("report-content-mismatch", { report });
    }
    expect(report).toContain("AppImage: 16 B");
    expect(report).toContain("Unpacked: 32 B");
    expect(report).toContain("- ffmpeg/ffmpeg: 8 B");
  });

  it("survives symlinked payload entries", () => {
    console.info("[report-packaged-size:setup] building fixture with real.bin (5B) + symlink");
    root = mkdtempSync(join(tmpdir(), "desktop-size-report-links-"));
    const resourcesDir = join(root, "resources");
    mkdirSync(resourcesDir, { recursive: true });
    writeFileSync(join(resourcesDir, "real.bin"), Buffer.alloc(5));
    symlinkSync(join(resourcesDir, "real.bin"), join(resourcesDir, "real-link.bin"));

    const topLevel = collectTopLevelEntries(resourcesDir, readdirSync);
    const pathSize = getPathSize(resourcesDir, readdirSync);
    console.info(
      `[report-packaged-size:collect] topLevel=${JSON.stringify(topLevel)} pathSize=${pathSize}`,
    );
    const expectedTopLevel = [
      { name: "real-link.bin", bytes: 5, type: "other" },
      { name: "real.bin", bytes: 5, type: "file" },
    ];
    if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel) || pathSize !== 10) {
      dumpSizeSnapshot("symlink-mismatch", { topLevel, pathSize, expectedTopLevel });
    }
    expect(topLevel).toEqual(expectedTopLevel);
    expect(pathSize).toBe(10);
  });
});
