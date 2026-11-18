import { beforeAll, describe, expect, it } from "vitest";
import { changeLanguage, initI18n, translate } from "@space/mobile-shell/i18n";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import {
  SPACE_RESERVE_BYTES,
  decideStart,
  derivePillState,
  describeError,
  formatBytes,
  isNetworkAllowed,
  itemPercent,
  pendingDownloadBytes,
  needsResume,
  requiredBytesFor,
} from "../src/lib/downloads/decisions";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

beforeAll(async () => {
  await initI18n("en");
  // The sizes asserted below are written in 1024-based units; the device's 1000-based case is tested on its own (STOR-UNIT-01).
  setStorageUnitBase(1024);
  console.info("[downloads-decisions] storage unit base", getStorageUnitBase());
});

const item = (over: Partial<DownloadItem> & { id: string }): DownloadItem => ({
  mediaId: "m",
  title: "T",
  subtitle: null,
  kind: "episode",
  seasonNumber: 1,
  episodeNumber: 1,
  quality: "1080p",
  formatId: "f",
  codec: "h264",
  status: "queued",
  errorCode: null,
  errorMessage: null,
  estimatedBytes: 1000,
  totalObjects: 10,
  doneBytes: 0,
  doneObjects: 0,
  storedBytes: 0,
  createdAt: 0,
  completedAt: 0,
  ...over,
});

const byId = (...items: DownloadItem[]) => new Map(items.map((i) => [i.id, i] as const));
const online = { networkAllowed: true, wifiOnly: true };

describe("Wi-Fi only gate", () => {
  it("allows only wifi/ethernet when wifiOnly", () => {
    expect(isNetworkAllowed(true, "wifi")).toBe(true);
    expect(isNetworkAllowed(true, "ethernet")).toBe(true);
    expect(isNetworkAllowed(true, "cellular")).toBe(false);
    expect(isNetworkAllowed(true, "other")).toBe(false);
    expect(isNetworkAllowed(true, "none")).toBe(false);
  });

  it("allows cellular when Wi-Fi only is off, never with no network", () => {
    expect(isNetworkAllowed(false, "cellular")).toBe(true);
    expect(isNetworkAllowed(false, "none")).toBe(false);
  });

  it("decideStart on cellular with Wi-Fi only → enqueue and wait for Wi-Fi", () => {
    const d = decideStart({ estimatedBytes: 100 * MB, freeBytes: 10 * GB, wifiOnly: true, networkType: "cellular" });
    console.info("cellular decision", d);
    expect(d).toEqual({ action: "enqueue", waitForWifi: true });
  });

  it("decideStart on Wi-Fi or on cellular with the setting off → start now", () => {
    expect(decideStart({ estimatedBytes: 1, freeBytes: 10 * GB, wifiOnly: true, networkType: "wifi" })).toEqual({ action: "enqueue", waitForWifi: false });
    expect(decideStart({ estimatedBytes: 1, freeBytes: 10 * GB, wifiOnly: false, networkType: "cellular" })).toEqual({ action: "enqueue", waitForWifi: false });
  });

  it("decideStart with no network at all is refused", () => {
    const d = decideStart({ estimatedBytes: 1, freeBytes: 10 * GB, wifiOnly: false, networkType: "none" });
    expect(d).toMatchObject({ action: "refuse", reason: "no_network" });
  });
});

describe("free-space check", () => {
  it("required = estimate × safety factor + 100 MB reserve", () => {
    expect(requiredBytesFor(0)).toBe(SPACE_RESERVE_BYTES);
    expect(requiredBytesFor(GB)).toBe(Math.ceil(GB * 1.05) + SPACE_RESERVE_BYTES);
  });

  it("refuses with a clear message when free space is below the requirement", () => {
    const d = decideStart({ estimatedBytes: 2 * GB, freeBytes: 2 * GB, wifiOnly: true, networkType: "wifi" });
    console.info("space refusal", d);
    expect(d.action).toBe("refuse");
    if (d.action !== "refuse" || d.reason !== "insufficient_space") throw new Error("expected insufficient_space");
    expect(d.requiredBytes).toBe(requiredBytesFor(2 * GB));
    expect(d.freeBytes).toBe(2 * GB);
    const message = translate("downloads.refused.insufficientSpace.message", {
      required: formatBytes(d.requiredBytes),
      free: formatBytes(d.freeBytes),
    });
    expect(message).toMatch(/Not enough storage/);
    expect(message).toContain("2.2 GB");
    expect(message).toContain("2.0 GB");
  });

  it("accepts exactly at the requirement and refuses one byte below", () => {
    const need = requiredBytesFor(GB);
    expect(decideStart({ estimatedBytes: GB, freeBytes: need, wifiOnly: false, networkType: "wifi" }).action).toBe("enqueue");
    expect(decideStart({ estimatedBytes: GB, freeBytes: need - 1, wifiOnly: false, networkType: "wifi" }).action).toBe("refuse");
  });

  it("space is checked before the network (clearest message first)", () => {
    const d = decideStart({ estimatedBytes: 5 * GB, freeBytes: 1 * GB, wifiOnly: true, networkType: "none" });
    expect(d).toMatchObject({ action: "refuse", reason: "insufficient_space" });
  });

  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * MB)).toBe("5 MB");
    expect(formatBytes(1.5 * GB)).toBe("1.5 GB");
  });

  // @req STOR-UNIT-01
  it("[STOR-UNIT-01-DL-01] formatBytes reads 1000-based on a phone, like its file manager, and 1024-based when pinned", () => {
    setStorageUnitBase(1000);
    const decimal = [formatBytes(0), formatBytes(512), formatBytes(5 * MB), formatBytes(1.5 * GB)];
    setStorageUnitBase(1024);
    const binary = [formatBytes(0), formatBytes(512), formatBytes(5 * MB), formatBytes(1.5 * GB)];
    console.info("[STOR-UNIT-01-DL-01] sizes per base", { decimal, binary });
    expect(decimal).toEqual(["0 MB", "512 B", "5 MB", "1.6 GB"]);
    expect(binary).toEqual(["0 MB", "512 B", "5 MB", "1.5 GB"]);
  });

  // @req STOR-UNIT-02[badger-mobile]
  it("[STOR-UNIT-02-DL-01] formatBytes writes the French separator and octet units, and the refusal reads them", async () => {
    try {
      await changeLanguage("fr");
      const sizes = [formatBytes(0), formatBytes(512), formatBytes(800 * MB), formatBytes(1.5 * GB), formatBytes(1.5 * 1024 * GB)];
      const message = translate("downloads.refused.insufficientSpace.message", {
        required: formatBytes(requiredBytesFor(2 * GB)),
        free: formatBytes(2 * GB),
      });
      console.info("[STOR-UNIT-02-DL-01] French sizes", { sizes, message });
      expect(sizes).toEqual(["0 Mo", "512 o", "800 Mo", "1,5 Go", "1,5 To"]);
      expect(message).toContain("2,2 Go");
      expect(message).toContain("2,0 Go");
    } finally {
      await changeLanguage("en");
    }
  });
});

describe("resume policy", () => {
  it("resumes unfinished work", () => {
    expect(needsResume([item({ id: "a", status: "queued" })])).toBe(true);
    expect(needsResume([item({ id: "a", status: "downloading" })])).toBe(true);
    expect(needsResume([item({ id: "a", status: "waiting_network" })])).toBe(true);
  });

  it("retries auth/network failures at app start but not space/storage failures", () => {
    expect(needsResume([item({ id: "a", status: "failed", errorCode: "auth" })])).toBe(true);
    expect(needsResume([item({ id: "a", status: "failed", errorCode: "network" })])).toBe(true);
    expect(needsResume([item({ id: "a", status: "failed", errorCode: "insufficient_space" })])).toBe(false);
    expect(needsResume([item({ id: "a", status: "failed", errorCode: "storage" })])).toBe(false);
  });

  it("nothing to do for completed or empty queues", () => {
    expect(needsResume([])).toBe(false);
    expect(needsResume([item({ id: "a", status: "completed" })])).toBe(false);
  });
});

describe("itemPercent", () => {
  it("is byte-based, capped at 99 until completed", () => {
    expect(itemPercent(item({ id: "a", status: "downloading", estimatedBytes: 1000, doneBytes: 250 }))).toBe(25);
    expect(itemPercent(item({ id: "a", status: "downloading", estimatedBytes: 1000, doneBytes: 1200 }))).toBe(99);
    expect(itemPercent(item({ id: "a", status: "completed", doneBytes: 0 }))).toBe(100);
  });

  it("falls back to object counts when the estimate is unknown", () => {
    expect(itemPercent(item({ id: "a", status: "downloading", estimatedBytes: 0, totalObjects: 10, doneObjects: 5 }))).toBe(50);
    expect(itemPercent(item({ id: "a", status: "queued", estimatedBytes: 0, totalObjects: 0 }))).toBe(0);
  });
});

describe("derivePillState", () => {
  it("idle without items or files", () => {
    expect(derivePillState(["a"], byId(), online)).toEqual({ kind: "idle" });
    expect(derivePillState([], byId(), online)).toEqual({ kind: "idle" });
  });

  it("queued / downloading with percent / downloaded", () => {
    expect(derivePillState(["a"], byId(item({ id: "a", status: "queued" })), online)).toEqual({ kind: "queued" });
    expect(
      derivePillState(["a"], byId(item({ id: "a", status: "downloading", doneBytes: 400 })), online),
    ).toEqual({ kind: "downloading", percent: 40 });
    expect(derivePillState(["a"], byId(item({ id: "a", status: "completed" })), online)).toEqual({ kind: "downloaded" });
  });

  it("waiting for Wi-Fi when the native gate is closed", () => {
    const state = derivePillState(["a"], byId(item({ id: "a", status: "waiting_network" })), { networkAllowed: false, wifiOnly: true });
    expect(state).toEqual({ kind: "waiting", reason: "wifi" });
    expect(
      derivePillState(["a"], byId(item({ id: "a", status: "downloading" })), { networkAllowed: false, wifiOnly: false }),
    ).toEqual({ kind: "waiting", reason: "network" });
  });

  it("failed → error + retryable, except out of space", () => {
    const net = derivePillState(["a"], byId(item({ id: "a", status: "failed", errorCode: "network" })), online);
    expect(net).toMatchObject({ kind: "error", retryable: true });
    const space = derivePillState(["a"], byId(item({ id: "a", status: "failed", errorCode: "insufficient_space" })), online);
    expect(space).toMatchObject({ kind: "error", error: { errorCode: "insufficient_space" }, retryable: false });
    expect(describeError({ errorCode: "insufficient_space", errorMessage: null })).toBe("Not enough free storage");
  });

  it("season scope aggregates: average percent, partial when some done and none active", () => {
    const files = ["a", "b"];
    const running = derivePillState(
      files,
      byId(item({ id: "a", status: "completed" }), item({ id: "b", status: "downloading", doneBytes: 0 })),
      online,
    );
    console.info("season running", running);
    expect(running).toEqual({ kind: "downloading", percent: 50 });
    expect(derivePillState(files, byId(item({ id: "a", status: "completed" })), online)).toEqual({ kind: "partial", completed: 1, total: 2 });
    expect(
      derivePillState(files, byId(item({ id: "a", status: "completed" }), item({ id: "b", status: "completed" })), online),
    ).toEqual({ kind: "downloaded" });
  });
});

describe("space check counts what is already queued", () => {
  // @bugfix @regression-proof: the check compared only the NEW download with free space, so with a
  // big season already queued the user was told "queued" and it failed with insufficient_space
  // hours later.
  it("@bugfix @regression-proof remaining bytes of queued and active items are reserved", () => {
    const items = [
      item({ id: "q", status: "queued", estimatedBytes: 4 * GB, doneBytes: 0 }),
      item({ id: "d", status: "downloading", estimatedBytes: 4 * GB, doneBytes: 3 * GB }),
      item({ id: "w", status: "waiting_network", estimatedBytes: 1 * GB, doneBytes: 0 }),
      item({ id: "c", status: "completed", estimatedBytes: 50 * GB, doneBytes: 50 * GB }),
      item({ id: "f", status: "failed", estimatedBytes: 50 * GB, doneBytes: 0 }),
    ];
    const pendingBytes = pendingDownloadBytes(items);
    console.info("pendingBytes", pendingBytes / GB);
    expect(pendingBytes).toBe(6 * GB);

    const free = 8 * GB;
    const alone = decideStart({ estimatedBytes: 3 * GB, freeBytes: free, wifiOnly: true, networkType: "wifi" });
    const withQueue = decideStart({ estimatedBytes: 3 * GB, pendingBytes, freeBytes: free, wifiOnly: true, networkType: "wifi" });
    console.info("alone", alone.action, "withQueue", withQueue.action);
    expect(alone.action).toBe("enqueue");
    expect(withQueue).toMatchObject({ action: "refuse", reason: "insufficient_space" });
  });
});
