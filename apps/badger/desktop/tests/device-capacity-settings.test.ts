/**
 * ACCT-SQUAD-03 (Chris 2026-10-30): the settings tied to a computer's capacity (parallel transcodes, parallel
 * extractions, watched folders) belong to that computer. They live in `<userData>/device-settings.json` next to the
 * 360p copy and the uploads-during-playback choice, and are taken once from the values the synced config held.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeviceSettingsStore } from "../src/main/deviceSettings";
import type { DeviceCapacityValues } from "../src/shared/deviceCapacity";

const P = "[device-capacity-settings]";

let dir = "";
let filePath = "";

const makeStore = () =>
  createDeviceSettingsStore({
    filePath,
    probeHardware: async () => {
      throw new Error("no hardware probe for capacity settings");
    },
    forcedDefault: "off",
    forcedUploadsDuringPlayback: "full",
    log: (line) => console.info(`${P}:store-log ${line}`),
  });

const FROM_SYNCED: DeviceCapacityValues = {
  maxParallelTranscodes: 3,
  maxParallelExtractions: 2,
  watchedDirectories: [{ id: "w1", label: "Films", path: "/media/films", library: "movies" }],
  offlineExportFormat: "mp4",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-device-capacity-"));
  filePath = join(dir, "device-settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("device capacity settings", () => {
  // @req ACCT-SQUAD-03[badger-desktop]
  it("takes the synced values once, then keeps this computer's own values", () => {
    const store = makeStore();
    expect(store.getCapacity()).toBeNull();

    const adopted = store.adoptCapacity(FROM_SYNCED);
    expect(adopted).toMatchObject(FROM_SYNCED);
    expect(adopted.source).toBe("synced-config");

    // Another computer's values arriving later through the synced config are not taken again.
    const again = makeStore().adoptCapacity({ maxParallelTranscodes: 1, maxParallelExtractions: 1, watchedDirectories: [], offlineExportFormat: "mkv" });
    expect(again).toMatchObject(FROM_SYNCED);

    const changed = store.setCapacity({ ...FROM_SYNCED, maxParallelTranscodes: 2 });
    expect(changed.source).toBe("settings");
    const reopened = makeStore().getCapacity();
    console.info(`${P}:file ${readFileSync(filePath, "utf8")}`);
    expect(reopened).toMatchObject({ ...FROM_SYNCED, maxParallelTranscodes: 2 });
  });

  // @req ACCT-SQUAD-03[badger-desktop]
  it("keeps the other device settings in the file and clamps bad values", async () => {
    const store = makeStore();
    await store.setUploadsDuringPlayback("pause");
    const stored = store.setCapacity({
      maxParallelTranscodes: 9,
      maxParallelExtractions: 0,
      watchedDirectories: [{ id: "x", label: "", path: "", library: "music" } as never],
      offlineExportFormat: "avi" as never,
    });
    expect(stored).toMatchObject({ maxParallelTranscodes: 3, maxParallelExtractions: 1, watchedDirectories: [], offlineExportFormat: "mkv" });
    const file = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(file.uploadsDuringPlayback).toMatchObject({ mode: "pause" });
    expect(file.capacity).toMatchObject({ maxParallelTranscodes: 3 });
  });

  // @req OFFL-FILE-01 @req ACCT-SQUAD-03[badger-desktop]
  it("a computer that stored its capacity before the download format moved here takes the account's format once", () => {
    const storedAt = "2026-10-31T00:00:00.000Z";
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        capacity: { maxParallelTranscodes: 2, maxParallelExtractions: 1, watchedDirectories: [], source: "settings", updatedAt: storedAt },
      }),
    );
    const store = makeStore();
    expect(store.getCapacity()?.offlineExportFormat).toBeUndefined();

    const adopted = store.adoptCapacity({ ...FROM_SYNCED, maxParallelTranscodes: 1 });
    console.info(`${P}:migrated ${readFileSync(filePath, "utf8")}`);
    expect(adopted).toMatchObject({ maxParallelTranscodes: 2, offlineExportFormat: "mp4", source: "settings", updatedAt: storedAt });

    // Taken once: a later synced value never replaces it.
    expect(makeStore().adoptCapacity({ ...FROM_SYNCED, offlineExportFormat: "mkv" }).offlineExportFormat).toBe("mp4");
    expect(store.setCapacity({ ...adopted, offlineExportFormat: "mkv" }).offlineExportFormat).toBe("mkv");
    expect(makeStore().getCapacity()?.offlineExportFormat).toBe("mkv");
  });
});
