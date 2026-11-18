export type StorageShard = {
  id: string;
  gatewayUrl: string;
  weight?: number;
  /**
   * Whether the silo takes NEW keys: only `active` (or absent) shards are hash candidates. `provisioning` = a silo that
   * is not activated yet (STOR-GATEWAY-13): it is listed so keys already pinned to it (`shards/<id>/…`) still resolve,
   * but no new key is hashed onto it.
   */
  status?: "active" | "disabled" | "draining" | "provisioning";
  addresses?: string[];
  /** Set when this shard id is an alias (a drained pool's id re-pointed at its successor): the silo whose gateway copies actually serve it. */
  servedBy?: string;
};

/** `S` lets the API carry its own fields on each shard (the gateway's internal address, which clients never see). */
export type StoragePlacementPolicy<S extends StorageShard = StorageShard> = {
  policy: "rendezvous-v1";
  epoch: number;
  seed: string;
  replicaCount: number;
  shards: S[];
};

export const STORAGE_SHARD_PREFIX = "shards";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

const toScore = (input: string): bigint => {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
};

const normalizeWeight = (value: number | undefined) => {
  if (!Number.isFinite(value ?? NaN)) return 1;
  return Math.max(1, Math.floor(value as number));
};

const weightedScore = (raw: bigint, weight: number) => raw * BigInt(weight);

export const pickPlacementShard = <S extends StorageShard>(
  policy: StoragePlacementPolicy<S>,
  objectKey: string
): S | null => {
  const key = objectKey.trim();
  if (!key) return null;
  const explicitShardId = parseShardIdFromObjectKey(key);
  if (explicitShardId) {
    // A pinned key names its silo: it resolves there unless the shard is disabled, so data already written on a silo
    // awaiting activation (`provisioning`, STOR-GATEWAY-13) stays readable.
    const pinned = policy.shards.find((shard) => shard.id === explicitShardId && shard.status !== "disabled");
    if (pinned) return pinned;
  }
  const active = policy.shards.filter((shard) => (shard.status ?? "active") === "active");
  if (active.length === 0) return null;
  let bestShard: S | null = null;
  let bestScore = -1n;
  for (const shard of active) {
    const scoreInput = `${policy.seed}|${policy.epoch}|${key}|${shard.id}`;
    const raw = toScore(scoreInput);
    const score = weightedScore(raw, normalizeWeight(shard.weight));
    if (!bestShard || score > bestScore) {
      bestShard = shard;
      bestScore = score;
    }
  }
  return bestShard;
};

export const parseShardIdFromObjectKey = (objectKey: string): string | null => {
  const normalized = objectKey.trim();
  if (!normalized) return null;
  const [prefix, shardId] = normalized.split("/", 3);
  if (prefix !== STORAGE_SHARD_PREFIX) return null;
  if (!shardId || !shardId.trim()) return null;
  return shardId.trim();
};

// ── Per-media placement (#145) ──────────────────────────────────
// One playable media (a film or a single episode) lives on one silo. The client
// mints an opaque placementId per media; the API records placementId → silo, so
// a move between silos flips that pointer without rewriting client-side keys.

export const MEDIA_PLACEMENT_PREFIX = "media";

const PLACEMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidPlacementId = (placementId: string): boolean => PLACEMENT_ID_PATTERN.test(placementId);

export type MediaPlacement = {
  placementId: string;
  poolId: string;
  shard: StorageShard;
};

export const parseMediaPlacementIdFromObjectKey = (objectKey: string): string | null => {
  const [prefix, placementId, rest] = objectKey.trim().split("/", 3);
  if (prefix !== MEDIA_PLACEMENT_PREFIX || !placementId || !rest) return null;
  return isValidPlacementId(placementId) ? placementId : null;
};

export const buildMediaObjectKey = (placementId: string, objectKey: string): string => {
  if (!isValidPlacementId(placementId)) throw new Error(`invalid placementId: ${placementId}`);
  const trimmedKey = objectKey.trim().replace(/^\/+/, "");
  if (!trimmedKey) throw new Error("buildMediaObjectKey: empty objectKey");
  const existing = parseMediaPlacementIdFromObjectKey(trimmedKey);
  if (existing === placementId) return trimmedKey;
  if (existing) throw new Error(`object key already placed under ${existing}`);
  return `${MEDIA_PLACEMENT_PREFIX}/${placementId}/${trimmedKey}`;
};

// ── Sharded object keys ─────────────────────────────────────────

export const buildShardedObjectKey = (shardId: string, objectKey: string): string => {
  const trimmedShard = shardId.trim();
  const trimmedKey = objectKey.trim().replace(/^\/+/, "");
  if (!trimmedShard) return trimmedKey;
  if (!trimmedKey) return `${STORAGE_SHARD_PREFIX}/${trimmedShard}`;
  const existingShard = parseShardIdFromObjectKey(trimmedKey);
  if (existingShard) return trimmedKey;
  return `${STORAGE_SHARD_PREFIX}/${trimmedShard}/${trimmedKey}`;
};
