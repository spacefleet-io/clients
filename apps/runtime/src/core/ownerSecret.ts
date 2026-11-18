/**
 * RT-SEC-05: the owner secret.
 *
 * A random 32-byte value created at every runtime start and written to
 * `<runtime data dir>/owner.secret` (owner-only: mode 0600 in a 0700 dir, a
 * user-only ACL on Windows). SpaceFleet's own apps read it from there (the
 * desktop main processes directly, their renderers through their main process)
 * and send it on `POST /runtime/session/login`; a web page can never read it.
 * It is removed again on a clean shutdown and replaced at the next start, so a
 * leaked value dies with the runtime that issued it.
 *
 * This module is the ONLY place that decides who may log in. The per-tool
 * grants of step 7b add their own entry to {@link OwnerLoginGate.authorize}
 * and nowhere else.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { PathLayer } from "@space/desktop-platform";
import { RUNTIME_OWNER_ERRORS, RUNTIME_OWNER_HEADER, RUNTIME_OWNER_SECRET_FILE, type RuntimeOwnerError } from "@space/runtime-contracts/lifecycle";

export const createOwnerSecret = (): string => randomBytes(32).toString("hex");

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Constant-time comparison of a presented secret with the real one. Both sides
 * are hashed first, so the comparison always runs over two 32-byte buffers
 * whatever the caller sent: neither the content nor the length of the secret
 * leaks through timing.
 */
export const ownerSecretMatches = (presented: string, expected: string): boolean =>
  timingSafeEqual(digest(presented), digest(expected));

export type OwnerSecretFile = {
  path: string;
  /** Delete the file, but only while it still holds OUR secret (a relaunched runtime may already own it). */
  remove: () => void;
};

export class OwnerSecretWriteError extends Error {
  constructor(path: string, cause: unknown) {
    super(`cannot write the owner secret to ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "OwnerSecretWriteError";
  }
}

/**
 * Atomically publish `secret` as `<dir>/owner.secret`: an empty temp file is
 * created owner-only, restricted (POSIX mode / Windows ACL) BEFORE the secret
 * goes in, filled, synced, then renamed over the real name. A reader therefore
 * sees either the previous file or the complete new one, and never a secret in
 * a file others can read. Throws {@link OwnerSecretWriteError} when any step
 * fails, including a platform that cannot make the file owner-only: the caller
 * must then refuse to serve.
 */
export const publishOwnerSecret = (options: {
  dir: string;
  secret: string;
  paths: Pick<PathLayer, "restrictFileToOwner" | "restrictDirToOwner">;
}): OwnerSecretFile => {
  const { dir, secret, paths } = options;
  const path = join(dir, RUNTIME_OWNER_SECRET_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    paths.restrictDirToOwner(dir);
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      paths.restrictFileToOwner(tmp);
      writeSync(fd, secret);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new OwnerSecretWriteError(path, error);
  }
  return {
    path,
    remove: () => {
      try {
        if (readFileSync(path, "utf8") === secret) unlinkSync(path);
      } catch {
        // Already gone, or not ours any more: nothing to clean up.
      }
    },
  };
};

export type OwnerLoginRefusal = { status: 401 | 429; error: RuntimeOwnerError; retryAfterSeconds?: number };

export type OwnerLoginGateOptions = {
  secret?: string;
  /** Wrong or missing secrets tolerated per window before further wrong ones get 429. */
  maxFailures?: number;
  windowMs?: number;
  clock?: () => number;
};

/**
 * The login gate. A caller gets in with the owner secret; everything else is
 * refused with a bare error code that says nothing about sessions.
 *
 * Failures are rate limited, never callers: once `maxFailures` wrong or missing
 * secrets arrived inside `windowMs`, further wrong ones are answered 429 until
 * the window slides on, while the right secret is still accepted. Our own apps
 * can therefore never be locked out by a program that hammers the endpoint, and
 * a guesser is held to `maxFailures` tries per window (the secret has 256 bits).
 */
export class OwnerLoginGate {
  readonly secret: string;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private failures: number[] = [];

  constructor(options: OwnerLoginGateOptions = {}) {
    this.secret = options.secret ?? createOwnerSecret();
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Decide a login request from its headers. Returns null when it may proceed,
   * else the refusal to send. Isolated here so the per-tool grants (7b) are one
   * more branch of this method.
   */
  authorize(headers: Pick<Headers, "get">): OwnerLoginRefusal | null {
    const presented = headers.get(RUNTIME_OWNER_HEADER)?.trim() ?? "";
    if (presented && ownerSecretMatches(presented, this.secret)) return null;
    const now = this.clock();
    this.failures = this.failures.filter((at) => now - at < this.windowMs);
    if (this.failures.length >= this.maxFailures) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.failures[0]! + this.windowMs - now) / 1000));
      return { status: 429, error: RUNTIME_OWNER_ERRORS.rateLimited, retryAfterSeconds };
    }
    this.failures.push(now);
    return { status: 401, error: presented ? RUNTIME_OWNER_ERRORS.invalid : RUNTIME_OWNER_ERRORS.required };
  }
}
