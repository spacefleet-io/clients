/**
 * Seed-derived chunk keys for new uploads (LIB-FMT-11, key mode 2). Each video format and audio track output gets one
 * random 16-byte seed; chunk i is stored under `seedChunkKey(seed, placementId, i)` from
 * `@space/library-db-definition/chunkLists`, the one derivation every reader shares (test vectors:
 * `packages/library-db-definition/test-vectors/chunk-lists.json`). The library then keeps the seed and the count
 * instead of every key. Only used once the account's library is converted to change types 4; before that every chunk
 * keeps a random key, as before.
 */
import { randomBytes } from "node:crypto";
import { CHUNK_LIST_SEED_BYTES, base64ToBytes, seedChunkKey } from "@space/library-db-definition/chunkLists";
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";

/** A fresh seed, standard padded base64 (the `chunkKeySeed` field of the job state and of the library write). */
export const newChunkKeySeed = (): string => randomBytes(CHUNK_LIST_SEED_BYTES).toString("base64");

/** The storage key of chunk `index` of an output whose seed is `seedBase64`. */
export const chunkKeyFromSeed = (seedBase64: string, placementId: string, index: number): string =>
  seedChunkKey(base64ToBytes(seedBase64), placementId, index);

/**
 * `seedBase64` when every key of `keys`, in order, is the key the seed derives for that index under the keys' one
 * placement; null otherwise (no seed, no keys, a key from a random upload, a missing chunk shifting the indexes). The
 * library only stores a list as a seed when this holds, so a seed never names keys that were not uploaded.
 */
export const verifiedChunkKeySeed = (seedBase64: string | null | undefined, keys: readonly string[]): string | null => {
  if (!seedBase64 || keys.length === 0) return null;
  const placementId = parseMediaPlacementIdFromObjectKey(keys[0]!);
  if (!placementId) return null;
  const seed = base64ToBytes(seedBase64);
  if (seed.length !== CHUNK_LIST_SEED_BYTES) return null;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== seedChunkKey(seed, placementId, i)) return null;
  }
  return seedBase64;
};
