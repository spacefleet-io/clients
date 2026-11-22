/**
 * ACCT-PAIR-07: the status a signed-in Badger or Parrot leaves for its sister app on this computer. It says only which
 * app is signed in, with which email, and how to start it: never a token, never a key. It is written at sign-in (and
 * at each start while signed in) and removed at sign-out, so the sister app's sign-in screen offers the account only
 * while it can really be used.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeSpaceAppId, siblingAppOf, type SpaceAppId } from "@space/shared/appScope";
import { writeOwnerOnlyFile, type SiblingPlace } from "./place";
import type { SiblingOffer } from "./types";

export type SiblingStatus = {
  v: 1;
  app: SpaceAppId;
  email: string;
  userId: string;
  exePath: string;
  args: string[];
  pid: number;
  updatedAt: string;
};

export type SiblingStatusInput = Omit<SiblingStatus, "v" | "updatedAt">;

const STATUS_MAX_BYTES = 16 * 1024;

const statusPath = (place: SiblingPlace, app: SpaceAppId) => join(place.dir, `${app}.json`);

export const writeSiblingStatus = (place: SiblingPlace, input: SiblingStatusInput): void => {
  const status: SiblingStatus = {
    v: 1,
    app: input.app,
    email: input.email,
    userId: input.userId,
    exePath: input.exePath,
    args: input.args,
    pid: input.pid,
    updatedAt: new Date().toISOString(),
  };
  writeOwnerOnlyFile(place, statusPath(place, input.app), `${JSON.stringify(status)}\n`);
};

export const removeSiblingStatus = (place: SiblingPlace, app: SpaceAppId): void => {
  rmSync(statusPath(place, app), { force: true });
};

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The app's status, or null when it is signed out, never ran, or the file is not one this code wrote. */
export const readSiblingStatus = (place: SiblingPlace, app: SpaceAppId): SiblingStatus | null => {
  let raw: string;
  try {
    raw = readFileSync(statusPath(place, app), "utf8");
  } catch {
    return null;
  }
  if (raw.length > STATUS_MAX_BYTES) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    parsed?.v !== 1 ||
    normalizeSpaceAppId(parsed.app) !== app ||
    typeof parsed.email !== "string" ||
    !parsed.email ||
    typeof parsed.userId !== "string" ||
    typeof parsed.exePath !== "string" ||
    !parsed.exePath ||
    !isStringArray(parsed.args) ||
    typeof parsed.pid !== "number" ||
    typeof parsed.updatedAt !== "string"
  ) {
    return null;
  }
  return parsed as SiblingStatus;
};

/** The sister app's account, when it is signed in on this computer and still installed where it said. */
export const readSiblingOffer = (place: SiblingPlace, asker: SpaceAppId): SiblingOffer | null => {
  const sister = siblingAppOf(asker);
  if (!sister) return null;
  const status = readSiblingStatus(place, sister);
  if (!status || !existsSync(status.exePath)) return null;
  return { app: sister, email: status.email };
};
