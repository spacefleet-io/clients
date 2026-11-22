/**
 * ACCT-PAIR-07: the per-user secret both apps send and check on the local channel. It lives in the user-only sibling
 * folder, so only a program running as this user can read it: another user on the computer reaching the socket or
 * the pipe is refused. Created once, by whichever app needs it first, and never rewritten.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeOwnerOnlyTemp, type SiblingPlace } from "./place";

const SECRET_PATTERN = /^[0-9a-f]{64}$/;

const readSecret = (path: string): string | null => {
  try {
    const value = readFileSync(path, "utf8").trim();
    return SECRET_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
};

export const ensureSiblingSecret = (place: SiblingPlace): string => {
  const path = join(place.dir, "secret");
  const existing = readSecret(path);
  if (existing) return existing;
  const fresh = randomBytes(32).toString("hex");
  const temp = writeOwnerOnlyTemp(place, path, fresh);
  try {
    // A link, not a rename: when the other app created the secret in the meantime, its secret stays and is read back.
    linkSync(temp, path);
    return fresh;
  } catch {
    const raced = readSecret(path);
    if (raced) return raced;
    // An unreadable leftover (cut short by a crash) is replaced once.
    rmSync(path, { force: true });
    linkSync(temp, path);
    return fresh;
  } finally {
    rmSync(temp, { force: true });
  }
};

/** HMAC-SHA256 of `text` under the per-user secret, as hex. The secret itself never goes on the channel. */
export const siblingMac = (secret: string, text: string): string => createHmac("sha256", secret).update(text).digest("hex");

/** Constant time whatever the lengths: both sides are hashed first. */
export const sameSiblingMac = (given: unknown, expected: string): boolean =>
  typeof given === "string" &&
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
