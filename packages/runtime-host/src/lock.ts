import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

export type SpawnLock = { release: () => void };

const holderPath = (lockDir: string) => joinPath(lockDir, "holder");

export const acquireSpawnLock = (lockDir: string, pid = process.pid): SpawnLock | null => {
  try {
    mkdirSync(lockDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  writeFileSync(holderPath(lockDir), String(pid));
  return {
    release: () => {
      try {
        unlinkSync(holderPath(lockDir));
      } catch {}
      try {
        rmdirSync(lockDir);
      } catch {}
    },
  };
};

export const readLockHolderPid = (lockDir: string): number | null => {
  try {
    const raw = readFileSync(holderPath(lockDir), "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const isSpawnLockStale = (lockDir: string): boolean => {
  const pid = readLockHolderPid(lockDir);
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

export const forceReleaseSpawnLock = (lockDir: string) => {
  try {
    unlinkSync(holderPath(lockDir));
  } catch {}
  try {
    rmdirSync(lockDir);
  } catch {}
};
