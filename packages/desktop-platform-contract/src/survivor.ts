import { spawn } from "node:child_process";
import type { Env } from "./types";

/**
 * `childLifetime.spawnSurvivor` on Linux and macOS: only a wrapped child is tied to its parent there (parent-death
 * signal, lifeline helper), so a plain detached spawn already outlives this process. Own process group, no stdio.
 */
export const spawnDetachedSurvivor = (command: string, args: string[], env: Env): number | null => {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
};
