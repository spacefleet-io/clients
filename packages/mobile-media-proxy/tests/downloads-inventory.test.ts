import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ modules: {} as Record<string, unknown> }));

vi.mock("react-native", () => ({
  get NativeModules() {
    return native.modules;
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  DeviceEventEmitter: { addListener: () => ({ remove: () => undefined }) },
}));

import { EMPTY_OFFLINE_INVENTORY, nativeListItems, nativeRemoveAll, parseOfflineInventory } from "../src/downloads";

const SUITE = "downloads-inventory";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

afterEach(() => {
  native.modules = {};
});

describe("OFFL-MANAGE-01 phone engine lists kept items and removes them all", () => {
  it("reads listItems' JSON (sizes, shared objects once in the total) @req OFFL-MANAGE-01", async () => {
    const testId = "list-items";
    const raw = JSON.stringify({
      items: [
        { itemId: "ep1", bytes: 1650, objectCount: 4, savedAt: 1_700_000_000_000 },
        { itemId: "ep2", bytes: 2750, objectCount: 4, savedAt: null },
      ],
      totalBytes: 3850,
    });
    const listItems = vi.fn(async () => raw);
    native.modules = { DownloadsBridge: { listItems } };
    const inventory = await nativeListItems();
    log(testId, "parsed", inventory);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(inventory.items.map((item) => [item.itemId, item.bytes, item.objectCount, item.savedAt])).toEqual([
      ["ep1", 1650, 4, 1_700_000_000_000],
      ["ep2", 2750, 4, null],
    ]);
    // Less than the per-item sum (4400): what the two episodes share is counted once.
    expect(inventory.totalBytes).toBe(3850);
  });

  it("tolerates missing fields and an absent engine @req OFFL-MANAGE-01", async () => {
    const testId = "tolerant";
    const parsed = parseOfflineInventory(JSON.stringify({ items: [{ itemId: "x" }] }));
    log(testId, "partial", parsed);
    expect(parsed).toEqual({ items: [{ itemId: "x", bytes: 0, objectCount: 0, savedAt: null }], totalBytes: 0 });
    const none = await nativeListItems();
    log(testId, "no-engine", none);
    expect(none).toBe(EMPTY_OFFLINE_INVENTORY);
  });

  it("remove-all calls the engine once @req OFFL-MANAGE-01", async () => {
    const testId = "remove-all";
    const removeAll = vi.fn(async () => true);
    native.modules = { DownloadsBridge: { removeAll } };
    const result = await nativeRemoveAll();
    log(testId, "called", { calls: removeAll.mock.calls.length, result });
    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });
});
