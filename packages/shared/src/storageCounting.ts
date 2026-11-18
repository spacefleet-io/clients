/**
 * How a stored object counts toward the storage allowance (STOR-USE-02). Every object is stored at its encrypted size;
 * what it counts is decided here, in one place for the apps (what they declare) and the API (what it records).
 *
 * - `source`: a piece of the file the user added. The file counts at the size their computer showed (`fs.stat`), so the
 *   app spreads that size over the file's source pieces in proportion to each piece's size (`apportionDeclaredBytes`)
 *   and declares each piece's share. The server never trusts a share below 90% of the piece's stored bytes.
 * - every other role is something made or kept for the user (a lower quality, subtitles, preview pictures, artwork):
 *   it counts at its stored bytes.
 * - an object uploaded without a role (an older app) is `other` and counts at its stored bytes.
 */
export const STORAGE_OBJECT_ROLES = ["source", "quality_copy", "subtitle", "preview", "artwork", "other"] as const;

export type StorageObjectRole = (typeof STORAGE_OBJECT_ROLES)[number];

/** What an app tells the silo about one object it uploads, forwarded to the API on the quota commit. */
export type StorageObjectCounting = {
  role: StorageObjectRole;
  /** `source` only: this piece's share of the file's original size (see `apportionDeclaredBytes`). */
  declaredBytes?: number;
};

/** A source piece never counts below this share of its stored bytes, whatever the app declares (STOR-USE-02). */
export const SOURCE_STORED_FLOOR_RATIO = 0.9;

export const isStorageObjectRole = (value: unknown): value is StorageObjectRole =>
  typeof value === "string" && (STORAGE_OBJECT_ROLES as readonly string[]).includes(value);

const wholeBytes = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * The bytes one stored object counts. `source` counts its declared share, never less than 90% of what it stores
 * (rounded up); a source without a declared share counts its stored bytes. Every other role counts its stored bytes.
 */
export const countedObjectBytes = (input: { role: StorageObjectRole; storedBytes: number; declaredBytes?: number | null }): number => {
  const stored = wholeBytes(input.storedBytes);
  if (input.role !== "source") return stored;
  const declared = input.declaredBytes == null ? null : wholeBytes(input.declaredBytes);
  if (declared === null) return stored;
  return Math.max(declared, Math.ceil(stored * SOURCE_STORED_FLOOR_RATIO));
};

/**
 * Spreads `totalBytes` (the original file's size) over pieces in proportion to `pieceBytes` (each piece's size).
 * The shares are whole bytes and add up exactly to `totalBytes`; the same inputs always give the same shares, so a
 * resumed upload declares the same share for a piece as the first try. With no piece bytes at all every share is 0.
 */
export const apportionDeclaredBytes = (totalBytes: number, pieceBytes: readonly number[]): number[] => {
  const total = wholeBytes(totalBytes);
  const sizes = pieceBytes.map(wholeBytes);
  const sum = sizes.reduce((acc, size) => acc + size, 0);
  if (sum <= 0) return sizes.map(() => 0);
  const shares: number[] = [];
  let cumulative = 0;
  let previousBoundary = 0;
  for (const size of sizes) {
    cumulative += size;
    // BigInt keeps total × cumulative exact for files far above 2^53 / 2^40 bytes.
    const boundary = Number((BigInt(total) * BigInt(cumulative) + BigInt(sum) / 2n) / BigInt(sum));
    shares.push(boundary - previousBoundary);
    previousBoundary = boundary;
  }
  return shares;
};
