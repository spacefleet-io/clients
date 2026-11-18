import { getDesktopPlatform } from "@space/desktop-platform";

/**
 * Out-of-process diagnostics the guardian takes when a health probe fails
 * (#25, ultimate stress P1). What the OS can tell about a stuck runtime
 * (procfs on Linux) lives in the desktop platform layer
 * (`getDesktopPlatform().diagnostics`); this file only exposes it as the
 * guardian's injectable readers.
 */
export type ProcessDiagnostics = Record<string, unknown>;
export type ProcessDiagnosticsReader = (pid: number) => Promise<ProcessDiagnostics>;

export type PortHolders = Record<string, unknown>;
export type PortHoldersReader = (port: number) => Promise<PortHolders>;

/** The platform's state dump of a pid (always includes `platform`). */
export const createProcessDiagnosticsReader = (): ProcessDiagnosticsReader => getDesktopPlatform().diagnostics.readProcess;

/** The platform's "who holds this listening TCP port" lookup (always includes `platform`). */
export const createPortHoldersReader = (): PortHoldersReader => getDesktopPlatform().diagnostics.readPortHolders;
