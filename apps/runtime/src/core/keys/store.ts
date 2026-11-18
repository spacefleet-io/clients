import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

type KeyEntry = {
  userId: string;
  masterKeyBase64: string;
  updatedAt: string;
};

/** What happened to a plaintext `runtime_keys.json` left by an earlier build. */
export type LegacyKeyFileMigration = {
  /** The file existed. */
  found: boolean;
  /** Keys moved into memory (then lost at the next runtime stop unless an app re-pushes them). */
  loaded: number;
  /** The file is gone. `false` means plaintext key bytes may still be on disk: surface it. */
  removed: boolean;
  /** The file's bytes were overwritten with zeros before it was unlinked. */
  overwritten: boolean;
};

/**
 * Overwrite a file's bytes with zeros, flush, then unlink it. Best effort: on
 * an SSD (wear levelling), a copy-on-write or journaling filesystem (btrfs,
 * APFS, ZFS, NTFS with shadow copies, ext4 `data=journal`) or after a backup or
 * snapshot, older copies of the bytes can survive the overwrite. A symlink is
 * only unlinked, never written through.
 */
export const shredFileSync = (filePath: string): { overwritten: boolean; removed: boolean } => {
  let overwritten = false;
  try {
    const stats = lstatSync(filePath);
    if (stats.isFile()) {
      const fd = openSync(filePath, "r+");
      try {
        const zeros = Buffer.alloc(Math.min(stats.size, 1 << 20));
        for (let written = 0; written < stats.size; ) {
          written += writeSync(fd, zeros, 0, Math.min(zeros.length, stats.size - written), written);
        }
        fsyncSync(fd);
        overwritten = true;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    // Unlink below regardless: a file we cannot overwrite must still go.
  }
  try {
    rmSync(filePath, { force: true });
  } catch {
    return { overwritten, removed: false };
  }
  return { overwritten, removed: !existsSync(filePath) };
};

/**
 * The runtime's library keys, held in memory only (RT-SEC-05).
 *
 * Nothing here is ever written to disk: the desktop apps hold the key in their
 * own protected storage and push it again (`POST /runtime/keys/set`) every time
 * the runtime becomes ready, and the runtime stops when its last app
 * disconnects, so no feature needs the runtime to unlock itself. A runtime that
 * restarted and was not re-pushed a key is "locked" (`status()`); the job
 * steps that need the key already wait for the app to re-attach.
 */
export class RuntimeKeyStore {
  private readonly keys = new Map<string, KeyEntry>();
  private legacyFileRemains = false;

  set(userId: string, masterKeyBase64: string) {
    const entry: KeyEntry = { userId, masterKeyBase64, updatedAt: new Date().toISOString() };
    this.keys.set(userId, entry);
    return entry;
  }

  get(userId: string): string | null {
    return this.keys.get(userId)?.masterKeyBase64 ?? null;
  }

  has(userId: string): boolean {
    return this.keys.has(userId);
  }

  clear(userId: string) {
    return this.keys.delete(userId);
  }

  entries(): KeyEntry[] {
    return [...this.keys.values()];
  }

  reset() {
    this.keys.clear();
  }

  /** Explicit lock state for a user, for `GET /runtime/keys/status`. */
  status(userId: string | null) {
    const keyed = userId ? this.keys.has(userId) : false;
    return {
      keyed,
      locked: !keyed,
      storage: "memory" as const,
      ...(keyed ? {} : { message: "Runtime locked: sign in on the desktop app to unlock it." }),
      // The old plaintext key file could not be deleted: the user has to remove it.
      ...(this.legacyFileRemains ? { legacyPlaintextFileRemains: true } : {}),
    };
  }

  /**
   * One-time migration of the plaintext `runtime_keys.json` written by builds
   * before RT-SEC-05: read it once into memory, then overwrite and delete it.
   * Keys already in memory win over the file's.
   */
  migrateLegacyPlaintextFile(filePath: string | null | undefined): LegacyKeyFileMigration {
    const path = filePath?.trim();
    if (!path || !existsSync(path)) return { found: false, loaded: 0, removed: true, overwritten: false };
    let loaded = 0;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { keys?: KeyEntry[] };
      for (const entry of Array.isArray(parsed?.keys) ? parsed.keys : []) {
        if (
          entry &&
          typeof entry.userId === "string" &&
          typeof entry.masterKeyBase64 === "string" &&
          !this.keys.has(entry.userId)
        ) {
          this.keys.set(entry.userId, {
            userId: entry.userId,
            masterKeyBase64: entry.masterKeyBase64,
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
          });
          loaded += 1;
        }
      }
    } catch {
      // Unreadable or not JSON: nothing to keep, the file still has to go.
    }
    const { overwritten, removed } = shredFileSync(path);
    this.legacyFileRemains = !removed;
    return { found: true, loaded, removed, overwritten };
  }
}

export const runtimeKeyStore = new RuntimeKeyStore();
export type { KeyEntry };
