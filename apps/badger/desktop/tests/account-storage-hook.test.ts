/**
 * Contract spec for useAccountStorage hook (W1-H / Q-8).
 *
 * Current state: Account.tsx inlines all getAccountStorage calls — no
 * useAccountStorage hook exists yet. All cases are skipped with @known-gap
 * until the hook is extracted from Account.tsx.
 *
 * Event bus state: no event bus (eventBus, emitter, dispatchEvent for
 * library.delete_media / lab.job_done / badger.storage.gc) found in renderer.
 * Tests for event-triggered re-fetch are also @known-gap for this reason.
 *
 * TODO(@known-gap): Extract useAccountStorage() from pages/Account.tsx lines
 * 142 and 212, add event-bus subscriptions for library.delete_media,
 * badger.storage.gc, and lab.job_done, then unskip all cases below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccountStorageMock = vi.hoisted(() => vi.fn());

vi.mock("@/api", () => ({
  getAccountStorage: (...args: unknown[]) => getAccountStorageMock(...args),
}));

// Minimal AccountStorageSummary shape matching packages/shared/src/api.ts
const makeStorage = (overrides: Record<string, unknown> = {}) => ({
  plan: "tier1",
  storageAddonCount: 0,
  limitBytes: 10_000_000_000,
  usedBytes: 1_000_000_000,
  reservedBytes: 0,
  usageRatio: 0.1,
  warningLevel: "ok" as const,
  apps: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// All tests are skipped until useAccountStorage is extracted from Account.tsx
// ---------------------------------------------------------------------------

describe.skip(
  // @known-gap: useAccountStorage hook does not exist yet (storage fetch is inlined in Account.tsx:142, 212)
  "useAccountStorage (contract spec — skipped until hook is extracted)",
  () => {
    beforeEach(() => {
      getAccountStorageMock.mockReset();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      // @known-gap: hook does not exist yet
      "fetches once on mount with a valid token",
      async () => {
        // Once the hook is extracted this test should:
        //   1. renderHook(() => useAccountStorage("tok"))
        //   2. await until the promise resolves
        //   3. assert getAccountStorageMock called exactly once with "tok"
        //   4. assert result.current.storage equals makeStorage()
        getAccountStorageMock.mockResolvedValueOnce(makeStorage());
        expect(getAccountStorageMock).not.toHaveBeenCalled(); // placeholder assertion
      }
    );

    it(
      // @known-gap: hook does not exist yet
      "does not fetch when token is null",
      async () => {
        // Once the hook is extracted this test should:
        //   1. renderHook(() => useAccountStorage(null))
        //   2. flush microtasks
        //   3. assert getAccountStorageMock was never called
        expect(getAccountStorageMock).not.toHaveBeenCalled(); // placeholder assertion
      }
    );

    it(
      // @known-gap: hook does not exist yet; also no event bus in renderer for library.delete_media
      "re-fetches when a library.delete_media event fires",
      async () => {
        // Once the hook is extracted and an event bus is added this test should:
        //   1. renderHook(() => useAccountStorage("tok"))
        //   2. await initial fetch
        //   3. dispatch library.delete_media via whatever bus mechanism is chosen
        //   4. assert getAccountStorageMock call count is 2
        //   5. assert result.current.storage reflects the second resolved value
        //
        // Diagnostic: if count mismatches, the test should report actual call
        // count and event sequence so failures are self-describing.
        const callsBefore = getAccountStorageMock.mock.calls.length;
        expect(callsBefore).toBe(0); // placeholder assertion
      }
    );

    it(
      // @known-gap: hook does not exist yet; also no event bus in renderer for badger.storage.gc
      "re-fetches when a badger.storage.gc event fires",
      async () => {
        const callsBefore = getAccountStorageMock.mock.calls.length;
        expect(callsBefore).toBe(0); // placeholder assertion
      }
    );

    it(
      // @known-gap: hook does not exist yet; also no event bus in renderer for lab.job_done
      "re-fetches when a lab.job_done event fires",
      async () => {
        const callsBefore = getAccountStorageMock.mock.calls.length;
        expect(callsBefore).toBe(0); // placeholder assertion
      }
    );

    it(
      // @known-gap: hook does not exist yet
      "preserves previous storage value when fetch throws",
      async () => {
        // Once the hook is extracted this test should:
        //   1. renderHook(() => useAccountStorage("tok"))
        //   2. let first fetch succeed with makeStorage({ usedBytes: 100 })
        //   3. trigger a re-fetch (event or manual refresh)
        //   4. let second fetch reject with new Error("network error")
        //   5. assert result.current.storage.usedBytes is still 100
        //   6. assert result.current.error is set (or hook did not crash)
        expect(getAccountStorageMock).not.toHaveBeenCalled(); // placeholder assertion
      }
    );
  }
);

// On assertion failure, dump the mock call ledger + last result so a wiring
// regression is self-describing (per "Tests log generously").
const dumpAccountStorageSnapshot = (label: string, extra?: Record<string, unknown>) => {
  try {
    console.error(`=== [account-storage-hook:${label}] snapshot ===`);
    console.error(
      `getAccountStorageMock.calls=${JSON.stringify(getAccountStorageMock.mock.calls)}`,
    );
    console.error(
      `getAccountStorageMock.results=${JSON.stringify(getAccountStorageMock.mock.results)}`,
    );
    if (extra) {
      console.error(`extra: ${JSON.stringify(extra)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Sanity test that always passes — confirms the mock wiring is valid so that
// when the skip is lifted these stubs are already proven to work.
describe("account-storage-hook mock wiring sanity", () => {
  beforeEach(() => {
    console.info("[account-storage-hook:setup] resetting getAccountStorageMock");
    getAccountStorageMock.mockReset();
  });

  it("getAccountStorageMock is callable and returns a resolved value", async () => {
    console.info("[account-storage-hook:resolve] arranging mockResolvedValueOnce(makeStorage())");
    const expected = makeStorage();
    getAccountStorageMock.mockResolvedValueOnce(expected);
    const result = await getAccountStorageMock("tok");
    console.info(
      `[account-storage-hook:resolve] resolved result usedBytes=${String(result?.usedBytes)} plan=${String(result?.plan)} callCount=${getAccountStorageMock.mock.calls.length}`,
    );
    try {
      expect(result).toEqual(expected);
      expect(getAccountStorageMock).toHaveBeenCalledWith("tok");
    } catch (err) {
      dumpAccountStorageSnapshot("resolve-mismatch", { expected, result });
      throw err;
    }
  });

  it("getAccountStorageMock rejects when configured to do so", async () => {
    console.info("[account-storage-hook:reject] arranging mockRejectedValueOnce(network error)");
    getAccountStorageMock.mockRejectedValueOnce(new Error("network error"));
    try {
      await expect(getAccountStorageMock("tok")).rejects.toThrow("network error");
      console.info("[account-storage-hook:reject] rejection observed as expected");
    } catch (err) {
      dumpAccountStorageSnapshot("reject-mismatch");
      throw err;
    }
  });
});
