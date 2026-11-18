import type { DesktopPlatform, PlatformArch } from "@space/desktop-platform-contract";
import { createWindowsBinaries } from "./binaries";
import { windowsDiagnostics } from "./diagnostics";
import { windowsHardware } from "./hardware";
import { windowsMpvIpc } from "./ipc";
import { windowsPaths } from "./paths";
import { windowsProcesses } from "./processes";
import { windowsShell } from "./shell";

const arch: PlatformArch = process.arch === "arm64" ? "arm64" : "x64";

/** The Windows implementation of the desktop platform contract (ADR 2026-10-13-desktop-platform-layer). */
export const platform: DesktopPlatform = {
  id: "windows",
  arch,
  binaries: createWindowsBinaries(arch),
  paths: windowsPaths,
  mpvIpc: windowsMpvIpc,
  processes: windowsProcesses,
  hardware: windowsHardware,
  diagnostics: windowsDiagnostics,
  shell: windowsShell,
};
