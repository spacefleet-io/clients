/**
 * One secret (a session token, a library key) in its own owner-only file, sealed by the operating system's
 * protected storage: Electron's `safeStorage` (Keychain, DPAPI, the Secret Service / KWallet). Where the system
 * offers none (a bare Linux session) the secret is written as is, readable only by the user (0600), and a warning
 * is logged (PRIV-KEY-04).
 *
 * Only Electron's ASYNC `safeStorage` API seals (ACCT-AUTH-08: the sync calls are deprecated in Electron 45 and
 * removed in 46). A file the async API cannot open (on Linux KDE it did not open what the sync `encryptString`
 * wrote) is opened with the sync `decryptString` while Electron still has it, then sealed again with the async API,
 * never downgraded to plain text. A `shouldReEncrypt` from the keyring re-seals it too.
 *
 * The bytes on disk are each app's own format (`SecretFileFormat`), so files written before this module keep
 * opening. Writes are tmp file → fsync → rename → fsync(dir), all on libuv's thread pool so a slow flush never
 * blocks Electron main (PERF-TIME-02): a kill at any instant leaves the previous complete file or the new one.
 *
 * Main process only. Electron is injected (`secretSafeStorage(safeStorage)`), so this module never imports it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** The subset of Electron's `safeStorage` a secret file uses: the async API. */
export type SecretSafeStorage = {
  isAsyncEncryptionAvailable: () => Promise<boolean>;
  encryptStringAsync: (plain: string) => Promise<Buffer>;
  decryptStringAsync: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
  /**
   * Migration only: Electron's sync `decryptString` (present up to Electron 45, removed in 46), for files the
   * async API cannot open. `undefined` once gone.
   */
  legacyDecryptString?: (encrypted: Buffer) => string;
};

/** Adapts Electron's `safeStorage` object; passes the sync `decryptString` only while Electron has it. */
export const secretSafeStorage = (
  safeStorage: Pick<SecretSafeStorage, "isAsyncEncryptionAvailable" | "encryptStringAsync" | "decryptStringAsync">,
): SecretSafeStorage => {
  const legacy: unknown = "decryptString" in safeStorage ? safeStorage.decryptString : undefined;
  return {
    isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptStringAsync: (plain) => safeStorage.encryptStringAsync(plain),
    decryptStringAsync: (encrypted) => safeStorage.decryptStringAsync(encrypted),
    legacyDecryptString:
      typeof legacy === "function" ? (encrypted: Buffer): string => String(legacy.call(safeStorage, encrypted)) : undefined,
  };
};

/** A secret as written: sealed by the system, or plain text where the system offers no protected storage. */
export type WrittenSecret = { kind: "sealed"; bytes: Buffer } | { kind: "plain"; text: string };

/** A secret as read back: the same two kinds. */
export type StoredSecret = WrittenSecret;

/** How an app lays a secret out on disk. `decode` throws on bytes it does not recognise. */
export type SecretFileFormat = {
  encode: (secret: WrittenSecret) => string | Buffer;
  decode: (raw: Buffer) => StoredSecret;
};

/** `enc:` + ciphertext, or `raw:` + the secret (Parrot desktop's `<name>.secret` files). */
export const taggedSecretFormat: SecretFileFormat = {
  encode: (secret) =>
    secret.kind === "sealed" ? Buffer.concat([Buffer.from("enc:"), secret.bytes]) : `raw:${secret.text}`,
  decode: (raw) => {
    const tag = raw.subarray(0, 4).toString("utf8");
    if (tag === "enc:") return { kind: "sealed", bytes: raw.subarray(4) };
    if (tag === "raw:") return { kind: "plain", text: raw.subarray(4).toString("utf8") };
    throw new Error("unknown secret file format");
  },
};

/**
 * JSON `{ v: 1, enc: "safeStorage", data: <base64 ciphertext> }` or `{ v: 1, enc: "plain", data: <secret> }`
 * (Badger desktop's `session.json`).
 */
export const envelopeSecretFormat: SecretFileFormat = {
  encode: (secret) =>
    JSON.stringify(
      secret.kind === "sealed"
        ? { v: 1, enc: "safeStorage", data: secret.bytes.toString("base64") }
        : { v: 1, enc: "plain", data: secret.text },
    ),
  decode: (raw) => {
    const file = JSON.parse(raw.toString("utf8")) as { v?: unknown; enc?: unknown; data?: unknown };
    if (file.v !== 1 || typeof file.data !== "string") throw new Error("unsupported secret file shape");
    if (file.enc === "safeStorage") return { kind: "sealed", bytes: Buffer.from(file.data, "base64") };
    if (file.enc === "plain") return { kind: "plain", text: file.data };
    throw new Error(`unsupported secret file encoding ${String(file.enc)}`);
  },
};

export type SecretFile = {
  /**
   * The secret, or `null` when there is none. Never rejects: an unreadable file reads as `null` (logged).
   * Re-seals the file with the async API when it was opened by the legacy sync call or the keyring rotated.
   */
  read: () => Promise<string | null>;
  /** Seal and write `value`, durable when it resolves. Rejects on an encryption or write failure. */
  write: (value: string) => Promise<void>;
  /** Delete the file; where the directory is not writable, empty it in place so it reads as no secret. */
  remove: () => void;
  exists: () => boolean;
};

const FILE_MODE = 0o600;

const fsyncDir = async (dir: string): Promise<void> => {
  // Directory fsync is not supported everywhere (Windows); the rename is still atomic there.
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort.
  }
};

const unlinkQuietly = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined); // Already gone.
};

let tmpSeq = 0;

/**
 * Write `data` to `filePath` (owner-only) so a kill at any instant leaves the old or the new complete file: tmp file
 * → fsync → rename → fsync(dir). Every disk call runs on libuv's thread pool, so the event loop keeps turning while
 * the disk flushes (PERF-TIME-02: e2e-ultimate c050 froze Electron main 15 s in a sync fsync while an upload was
 * copying). Durable when it resolves. Concurrent calls on one path must be serialized by the caller (last rename wins).
 */
export const writeFileDurably = async (filePath: string, data: string | Buffer): Promise<void> => {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${++tmpSeq}`;
  const handle = await open(tmp, "w", FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlinkQuietly(tmp);
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await unlinkQuietly(tmp);
    throw err;
  }
  await fsyncDir(dir);
};

export const createSecretFile = (options: {
  path: string;
  format: SecretFileFormat;
  safeStorage: SecretSafeStorage | null;
  log: (line: string) => void;
  /** Log prefix, e.g. `session-store`. */
  label: string;
}): SecretFile => {
  const { path, format, safeStorage, log, label } = options;
  /** Durable writes of this file, in the order their encryption finished, so an older value never lands last. */
  let flushed: Promise<unknown> = Promise.resolve();

  const write = async (value: string): Promise<void> => {
    let secret: WrittenSecret;
    if (safeStorage && (await safeStorage.isAsyncEncryptionAvailable())) {
      secret = { kind: "sealed", bytes: await safeStorage.encryptStringAsync(value) };
    } else {
      log(`[${label}] OS encryption unavailable: stored in an owner-only (0600) file, unencrypted`);
      secret = { kind: "plain", text: value };
    }
    const bytes = format.encode(secret);
    const run = flushed.then(() => writeFileDurably(path, bytes));
    flushed = run.catch(() => undefined);
    await run;
  };

  /** `reseal` = write it again with `encryptStringAsync`. */
  const unseal = async (bytes: Buffer): Promise<{ value: string; reseal: boolean }> => {
    if (!safeStorage) throw new Error("the file is encrypted but safeStorage is unavailable");
    try {
      const decrypted = await safeStorage.decryptStringAsync(bytes);
      if (decrypted.shouldReEncrypt) log(`[${label}] keyring key rotated: re-encrypting`);
      return { value: decrypted.result, reseal: decrypted.shouldReEncrypt };
    } catch (asyncErr) {
      if (!safeStorage.legacyDecryptString) throw asyncErr;
      log(`[${label}] decryptStringAsync failed (${String(asyncErr)}); trying the legacy sync decryptString`);
      const value = safeStorage.legacyDecryptString(bytes);
      log(`[${label}] opened with the legacy sync decryptString: migrating to encryptStringAsync`);
      return { value, reseal: true };
    }
  };

  const reseal = async (value: string): Promise<void> => {
    try {
      // Never downgrade an encrypted file to plain text: without the async encryptor keep the old ciphertext,
      // it still opens on the next launch.
      if (!(safeStorage && (await safeStorage.isAsyncEncryptionAvailable()))) {
        log(`[${label}] async encryption unavailable: keeping the old ciphertext for now`);
        return;
      }
      await write(value);
      log(`[${label}] re-encrypted with encryptStringAsync`);
    } catch (err) {
      // The old ciphertext still opens; try again next time.
      log(`[${label}] re-encrypting failed: ${String(err)}`);
    }
  };

  const read = async (): Promise<string | null> => {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`[${label}] unreadable ${path}: ${String(err)}`);
      return null;
    }
    if (raw.length === 0) return null;
    let opened: { value: string; reseal: boolean };
    try {
      const stored = format.decode(raw);
      opened = stored.kind === "plain" ? { value: stored.text, reseal: false } : await unseal(stored.bytes);
    } catch (err) {
      log(`[${label}] unreadable ${path}, treated as no secret: ${String(err)}`);
      return null;
    }
    if (opened.reseal) await reseal(opened.value);
    return opened.value;
  };

  const remove = (): void => {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        // Directory not writable: empty it in place so it reads as no secret.
        writeFileSync(path, "");
      } catch (truncateErr) {
        log(`[${label}] could not remove ${path}: ${String(truncateErr)}`);
      }
    }
  };

  return { read, write, remove, exists: () => existsSync(path) };
};
