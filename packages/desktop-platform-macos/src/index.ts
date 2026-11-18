import { existsSync } from "node:fs";
import { firstExisting } from "@space/desktop-platform-contract";
import type { DesktopPlatform, PlatformArch } from "@space/desktop-platform-contract";
import { createMacosBinaries } from "./binaries";
import { macosDiagnostics } from "./diagnostics";
import { macosHardware } from "./hardware";
import { macosMpvIpc } from "./ipc";
import { macosPaths } from "./paths";
import { createMacosProcesses, LIFELINE_NAME } from "./processes";
import { macosShell } from "./shell";

const arch: PlatformArch = process.arch === "arm64" ? "arm64" : "x64";
const binaries = createMacosBinaries(arch);

/** The macOS implementation of the desktop platform contract (ADR 2026-10-13-desktop-platform-layer). */
export const platform: DesktopPlatform = {
  id: "macos",
  arch,
  binaries,
  paths: macosPaths,
  mpvIpc: macosMpvIpc,
  processes: createMacosProcesses({
    // `SF_LIFELINE_BIN` (operator / test override, like SF_MPV_EXTERNAL_BIN), else `bin/sf-lifeline` of the deps bundle
    // the runtime's ffmpeg comes from (found the same way: SF_APP_ROOT packaged, the checkout's vendor/deps otherwise).
    locateLifeline: () => {
      const override = process.env.SF_LIFELINE_BIN?.trim();
      if (override) return existsSync(override) ? override : null;
      return firstExisting(binaries.searchDirs({ env: process.env }), LIFELINE_NAME)?.path ?? null;
    },
  }),
  hardware: macosHardware,
  diagnostics: macosDiagnostics,
  shell: macosShell,
};
