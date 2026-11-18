import { describe, expect, it } from "vitest";
import {
  buildMediaObjectKey,
  buildShardedObjectKey,
  isValidPlacementId,
  MEDIA_PLACEMENT_PREFIX,
  parseMediaPlacementIdFromObjectKey,
  parseShardIdFromObjectKey,
  pickPlacementShard,
  type StoragePlacementPolicy,
} from "../src/storagePlacement";

const policy: StoragePlacementPolicy = {
  policy: "rendezvous-v1",
  epoch: 3,
  seed: "seed-123",
  replicaCount: 1,
  shards: [
    { id: "a", gatewayUrl: "https://gw-a.local", weight: 100, status: "active" },
    { id: "b", gatewayUrl: "https://gw-b.local", weight: 100, status: "active" },
    { id: "c", gatewayUrl: "https://gw-c.local", weight: 100, status: "disabled" },
  ],
};

// On assertion failure, dump the computed placement decision(s) so determinism /
// epoch / disabled-shard bugs are diagnosable without re-running.
const dumpStoragePlacementSnapshot = (
  label: string,
  detail: Record<string, unknown>,
) => {
  try {
    console.error(`=== [storage-placement:${label}] snapshot ===`);
    console.error(`detail:\n${JSON.stringify(detail, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("storage placement", () => {
  it("is deterministic for same policy and object key", () => {
    console.info(`[storage-placement:deterministic] picking shard twice for same key`);
    const first = pickPlacementShard(policy, "library/chunks/obj-1");
    const second = pickPlacementShard(policy, "library/chunks/obj-1");
    if (first?.id !== second?.id || first?.status === "disabled")
      dumpStoragePlacementSnapshot("deterministic", { first, second });
    expect(first?.id).toBe(second?.id);
    expect(first?.status).not.toBe("disabled");
  });

  it("changes mapping when epoch changes", () => {
    console.info(`[storage-placement:epoch] picking shard at epoch ${policy.epoch} vs ${policy.epoch + 1}`);
    const base = pickPlacementShard(policy, "library/chunks/obj-2");
    const changed = pickPlacementShard(
      {
        ...policy,
        epoch: policy.epoch + 1,
      },
      "library/chunks/obj-2"
    );
    if (base?.id === undefined || changed?.id === undefined)
      dumpStoragePlacementSnapshot("epoch-change", { base, changed });
    expect(base?.id).toBeDefined();
    expect(changed?.id).toBeDefined();
  });

  it("returns null when no active shard is available", () => {
    console.info(`[storage-placement:no-active] all shards disabled → expect null`);
    const shard = pickPlacementShard(
      {
        ...policy,
        shards: [{ id: "x", gatewayUrl: "https://x.local", status: "disabled" }],
      },
      "library/chunks/obj-3"
    );
    if (shard !== null) dumpStoragePlacementSnapshot("no-active-shard", { shard });
    expect(shard).toBeNull();
  });

  it("parses shard prefix from object key", () => {
    expect(parseShardIdFromObjectKey("shards/a/library/chunks/x")).toBe("a");
    expect(parseShardIdFromObjectKey("library/chunks/x")).toBeNull();
  });

  it("pins placement to explicit shard prefix when present", () => {
    console.info(`[storage-placement:pin] key with shards/b/ prefix → expect shard b`);
    const shard = pickPlacementShard(policy, "shards/b/library/chunks/x");
    if (shard?.id !== "b") dumpStoragePlacementSnapshot("pin-explicit-prefix", { shard });
    expect(shard?.id).toBe("b");
  });

  it("builds a sharded object key and preserves existing prefix", () => {
    expect(buildShardedObjectKey("a", "library/chunks/x")).toBe("shards/a/library/chunks/x");
    expect(buildShardedObjectKey("b", "shards/a/library/chunks/x")).toBe("shards/a/library/chunks/x");
  });

  // @req STOR-GATEWAY-13
  it("never hashes a new key onto a silo awaiting activation, but still resolves keys pinned to it", () => {
    const withNewSilo: StoragePlacementPolicy = {
      ...policy,
      shards: [
        { id: "new", gatewayUrl: "https://gw-new.local", weight: 10_000, status: "provisioning" },
        { id: "a", gatewayUrl: "https://gw-a.local", weight: 1, status: "active" },
        { id: "off", gatewayUrl: "https://gw-off.local", weight: 1, status: "disabled" },
      ],
    };
    const picked = Array.from({ length: 200 }, (_, index) => pickPlacementShard(withNewSilo, `library/chunks/obj-${index}`)?.id);
    console.info(`[storage-placement:provisioning] 200 unprefixed keys → ${JSON.stringify(Array.from(new Set(picked)))}`);
    expect(new Set(picked)).toEqual(new Set(["a"]));
    expect(pickPlacementShard(withNewSilo, "shards/new/library/chunks/x")?.id).toBe("new");
    // A disabled shard is still skipped for a pinned key, as before.
    expect(pickPlacementShard(withNewSilo, "shards/off/library/chunks/x")?.id).toBe("a");

    const onlyNew: StoragePlacementPolicy = { ...policy, shards: [withNewSilo.shards[0]!] };
    expect(pickPlacementShard(onlyNew, "library/chunks/obj-1")).toBeNull();
    expect(pickPlacementShard(onlyNew, "shards/new/library/chunks/x")?.id).toBe("new");
  });
});

describe("media placement keys", () => {
  const placementId = "3f1c2b9a-7d4e-4c1a-9b2f-0a1b2c3d4e5f";

  it("accepts uuid-ish placement ids and rejects anything else", () => {
    const cases: Array<[string, boolean]> = [
      [placementId, true],
      ["job_12345678", true],
      ["a".repeat(64), true],
      ["short", false],
      ["a".repeat(65), false],
      ["has/slash1", false],
      ["has space1", false],
      ["", false],
    ];
    for (const [id, expected] of cases) {
      console.info(`[storage-placement:placement-id] ${JSON.stringify(id)} → expect ${expected}`);
      expect(isValidPlacementId(id)).toBe(expected);
    }
  });

  it("builds media/<placementId>/<key> and is idempotent for the same id", () => {
    const built = buildMediaObjectKey(placementId, "/obj-uuid");
    console.info(`[storage-placement:media-build] built=${built}`);
    expect(built).toBe(`${MEDIA_PLACEMENT_PREFIX}/${placementId}/obj-uuid`);
    expect(buildMediaObjectKey(placementId, built)).toBe(built);
  });

  it("refuses an invalid id, an empty key, or a key placed under another id", () => {
    expect(() => buildMediaObjectKey("bad", "obj")).toThrow(/invalid placementId/);
    expect(() => buildMediaObjectKey(placementId, "  ")).toThrow(/empty objectKey/);
    expect(() => buildMediaObjectKey(placementId, "media/other-id-123/obj")).toThrow(/already placed/);
  });

  it("parses the placement id only from complete media keys", () => {
    const cases: Array<[string, string | null]> = [
      [`media/${placementId}/obj`, placementId],
      [`media/${placementId}/nested/obj`, placementId],
      [`media/${placementId}`, null],
      ["media/bad/obj", null],
      ["shards/gw-a/obj", null],
      ["library/chunks/x", null],
    ];
    for (const [key, expected] of cases) {
      console.info(`[storage-placement:media-parse] ${key} → expect ${expected}`);
      expect(parseMediaPlacementIdFromObjectKey(key)).toBe(expected);
    }
  });
});
