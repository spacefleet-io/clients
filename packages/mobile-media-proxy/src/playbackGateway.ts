import { ApiError, getStoragePlacementPolicy, resolveMediaPlacement } from "@space/shared/api";

/**
 * Ordered gateway candidate URLs for the native StorageTunnelClient, which
 * walks the list sequentially at session creation time (Phase 2B waterfall)
 * with a 3s per-attempt timeout, so the first reachable candidate wins.
 *
 * Order: shard.gatewayUrl FIRST (canonical), then any shard.addresses
 * entries (LAN IPs, STUN public IP), deduped + trailing-slash-normalized.
 * Mirrors the candidate-build pass in createUserStorageTunnelClient
 * (waterfall branch) at packages/shared/src/storageTunnel.ts.
 */
const buildCandidates = (gatewayUrl: string, addresses: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [gatewayUrl, ...(addresses ?? [])]) {
    const normalized = raw.trim().replace(/\/+$/, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }
  return candidates;
};

/**
 * Media stored under a per-media placement (#145, keys `media/<id>/…`) is
 * served only by the silo holding that placement, so its candidates come from
 * the placement resolve endpoint. `placementId === null` (legacy
 * `shards/…` / bare keys) keeps the first-active-shard pick from
 * `/storage/placement`.
 */
export const resolveGatewayCandidates = async (token: string, placementId: string | null): Promise<string[]> => {
  if (placementId) {
    const placement = await resolveMediaPlacement(token, placementId);
    console.info(
      "playback.gateway.media_placement",
      JSON.stringify({ placementId, poolId: placement.poolId, shardId: placement.shard.id })
    );
    return buildCandidates(placement.shard.gatewayUrl, placement.shard.addresses);
  }
  const { policy } = await getStoragePlacementPolicy(token).catch((error: unknown) => {
    throw error instanceof ApiError ? new Error(`storage_placement_failed_${error.status}`) : error;
  });
  // A silo not activated yet holds no legacy key (STOR-GATEWAY-13): it is never the first pick.
  const active = (policy?.shards ?? []).find(
    (entry) => entry.status !== "disabled" && entry.status !== "provisioning" && entry.gatewayUrl
  );
  if (!active?.gatewayUrl) {
    throw new Error("no_storage_gateways_available");
  }
  return buildCandidates(active.gatewayUrl, active.addresses);
};
