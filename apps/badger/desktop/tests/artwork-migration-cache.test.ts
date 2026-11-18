/**
 * @test-id DESKTOP-ARTWORK-MIGRATION-CACHE
 * @level unit
 * @req META-ART-01[badger-desktop]
 * @why A whole-library artwork migration must not undo "local cache first": the metadata service's answers it
 *      fetches (each needed once, for the upload) may not push the decrypted vault copies browsing reads out of the
 *      byte-bounded artwork store. And the library is re-read after copies at most once per gap, not after every
 *      migrated title (which re-rendered the whole library every few seconds for the length of a migration).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataClient } from "@space/metadata-client";
import { createDesktopImageResolver } from "../src/renderer/src/lib/metadataTickets";
import { getRendererArtworkStore } from "../src/renderer/src/lib/artworkCache";
import { coalesceRefresh } from "../src/renderer/src/lib/coalesceRefresh";

const SUITE = "artwork-migration-cache";
const phase = (name: string, extra?: string) => console.info(`[${SUITE}:${name}]${extra ? ` ${extra}` : ""}`);

describe("desktop artwork migration and the local cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("service answers fetched for copies never evict the decrypted vault copies", async () => {
    const store = getRendererArtworkStore();
    await store.clear();
    const vaultKey = "vault|asset:poster::assets/kept.txt";
    await store.put(vaultKey, `data:image/jpeg;base64,${"V".repeat(1024)}`);
    // 4 MiB answers: 60 of them is more than the store's 192 MiB bound.
    const big = `data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`;
    const client = { imageUrl: vi.fn(async () => ({ url: big })) } as unknown as MetadataClient;
    const resolver = createDesktopImageResolver(client);
    phase("migrate", "resolving 60 large images");
    for (let i = 0; i < 60; i += 1) expect((await resolver.resolveDetailed("poster", `/p${i}.jpg`)).status).toBe("ok");
    const kept = await store.get(vaultKey);
    phase("after", `vaultCopyKept=${kept !== null}`);
    expect(kept).not.toBeNull();
  });

  it("re-reads the library at once for the first copy, then at most once per gap", async () => {
    vi.useFakeTimers();
    let now = 0;
    const at: number[] = [];
    const refresh = vi.fn(async () => void at.push(now));
    const coalesced = coalesceRefresh(refresh, { minGapMs: 15_000, now: () => now });
    coalesced.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    // A migration: one title every 2 s for 30 s.
    for (let t = 2_000; t <= 30_000; t += 2_000) {
      now = t;
      vi.advanceTimersByTime(2_000);
      coalesced.request();
    }
    now = 45_000;
    vi.advanceTimersByTime(15_000);
    phase("migration", `refreshes=${refresh.mock.calls.length} at=${at.join(",")} titles=16`);
    // First at once, then at most one per 15 s gap, and the last copy (t=30 s) is always followed by a refresh.
    expect(at).toEqual([0, 16_000, 45_000]);
    // A cancel drops a pending refresh and refuses later ones.
    now = 46_000;
    coalesced.request();
    coalesced.cancel();
    vi.advanceTimersByTime(60_000);
    const settled = refresh.mock.calls.length;
    coalesced.request();
    expect(refresh.mock.calls.length).toBe(settled);
  });
});
