import { readFileSync, writeFileSync } from "node:fs";

const parsePids = (raw: string): number[] =>
  raw
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0);

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const readPidsFromFile = (refsPath: string): number[] => {
  try {
    return parsePids(readFileSync(refsPath, "utf8"));
  } catch {
    return [];
  }
};

export const getLivePids = (refsPath: string): number[] =>
  readPidsFromFile(refsPath).filter(isPidAlive);

export const registerPid = (refsPath: string, pid: number) => {
  const pids = readPidsFromFile(refsPath);
  if (pids.includes(pid)) return;
  writeFileSync(refsPath, [...pids, pid].join("\n") + "\n");
};

export const unregisterPid = (refsPath: string, pid: number): number[] => {
  const remaining = readPidsFromFile(refsPath)
    .filter((p) => p !== pid)
    .filter(isPidAlive);
  writeFileSync(refsPath, remaining.length > 0 ? remaining.join("\n") + "\n" : "");
  return remaining;
};

export const readRuntimePid = (pidPath: string): number | null => {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const writeRuntimePid = (pidPath: string, pid: number) => {
  writeFileSync(pidPath, String(pid));
};
