import type { DesktopPlatform, PlatformArch } from "@space/desktop-platform-contract";
import { createLinuxBinaries } from "./binaries";
import { linuxDiagnostics } from "./diagnostics";
import { linuxHardware } from "./hardware";
import { linuxMpvIpc } from "./ipc";
import { linuxPaths } from "./paths";
import { linuxProcesses } from "./processes";
import { linuxShell } from "./shell";

const arch: PlatformArch = process.arch === "arm64" ? "arm64" : "x64";

/** The Linux implementation of the desktop platform contract (ADR 2026-10-13-desktop-platform-layer). */
export const platform: DesktopPlatform = {
  id: "linux",
  arch,
  binaries: createLinuxBinaries(arch),
  paths: linuxPaths,
  mpvIpc: linuxMpvIpc,
  processes: linuxProcesses,
  hardware: linuxHardware,
  diagnostics: linuxDiagnostics,
  shell: linuxShell,
};
