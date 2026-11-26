/**
 * @regression-proof
 * PLAT-DESK-10: Parrot ships the same tray icon set as Badger: the square colour icon (window, Linux / Windows tray)
 * and the 16 px + 32 px @2x monochrome template image for the macOS menu bar, all copied into resources/ where the
 * main process looks for them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig, TRAY_TEMPLATE_ICONS } from "../electron-builder.config.mjs";
import { SIGNED_WINDOWS_ENV } from "@space/desktop-platform-windows/packaging/signedWindowsEnv";

const installer = join(__dirname, "..", "installer");
const log = (line: string, data?: unknown) =>
  console.info(`[parrot-tray-icons] ${line}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const pngHeader = (path: string) => {
  const png = readFileSync(path);
  return { magic: png.subarray(1, 4).toString(), width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
};

// @req PLAT-DESK-10 (Parrot ships Badger's tray icon set)
describe("Parrot tray icons (PLAT-DESK-10)", () => {
  it("has a 16 px + 32 px @2x RGBA template image and a square >= 256 px colour icon", () => {
    for (const [name, size] of [["trayTemplate.png", 16], ["trayTemplate@2x.png", 32]] as const) {
      const header = pngHeader(join(installer, name));
      log(name, header);
      // colour type 6 = RGBA: a template image is all alpha
      expect(header).toEqual({ magic: "PNG", width: size, height: size, colorType: 6 });
    }
    const icon = pngHeader(join(installer, "icon.png"));
    log("icon.png", icon);
    expect(icon.width).toBe(icon.height);
    expect(icon.width).toBeGreaterThanOrEqual(256);
  });

  it("copies the icon and the template images into resources/ on every target", () => {
    for (const targetId of ["linux-x64", "windows-x64", "macos-arm64", "macos-x64"]) {
      // A Windows build must be signed (REL-INST-03): fake Artifact Signing secrets, the config never contacts Azure.
      const config = createBuilderConfig({ targetId, env: SIGNED_WINDOWS_ENV }) as { extraResources: Array<{ from: string; to: string }> };
      const shipped = config.extraResources.map((entry) => entry.to).sort();
      log(`${targetId} extraResources`, shipped);
      expect(shipped).toEqual(["icon.png", ...TRAY_TEMPLATE_ICONS].sort());
    }
  });
});
