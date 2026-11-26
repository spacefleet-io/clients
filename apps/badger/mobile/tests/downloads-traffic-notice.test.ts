/**
 * @test-id MOBILE-DOWNLOADS-TRAFFIC-NOTICE-001
 * @level unit
 *
 * Why exists: under high traffic the downloads run slower (STOR-BW-01) and under a saturated silo they are held
 * (STOR-BW-09). The viewer must be told which, on the Downloads screen, in both languages, with the product's wording
 * and no mention of the evening. The native engine reports `traffic` in its state JSON; this pins the parse, the notice
 * decision (only while a download actually waits on the silo) and the EN/FR strings.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ NativeModules: {}, DeviceEventEmitter: { addListener: vi.fn() } }));

import { parseDownloadsState } from "@space/mobile-media-proxy/downloads";
import { trafficNoticeKey } from "../src/lib/downloads/trafficNotice";
import type { DownloadItem, DownloadsState } from "@space/mobile-media-proxy/downloads";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";

const item = (status: DownloadItem["status"]): DownloadItem => ({
  id: "f1", mediaId: "m1", title: "T", subtitle: null, kind: "movie", seasonNumber: null, episodeNumber: null,
  quality: "1080p", formatId: "x", codec: "hevc", status, errorCode: null, errorMessage: null, estimatedBytes: 10,
  totalObjects: 2, doneBytes: 1, doneObjects: 0, storedBytes: 0, createdAt: 0, completedAt: 0,
});
const state = (traffic: DownloadsState["traffic"], ...statuses: DownloadItem["status"][]) => ({ items: statuses.map(item), traffic });

describe("native downloads state carries the traffic rule", () => {
  /** @req STOR-BW-01[badger-mobile] */
  it("parses slowed and held, and reads anything else (old engines send none) as normal", () => {
    for (const [wire, want] of [["slowed", "slowed"], ["held", "held"], ["normal", "normal"], ["bogus", "normal"], [undefined, "normal"]] as const) {
      const parsed = parseDownloadsState(JSON.stringify({ items: [], traffic: wire }));
      console.info("[downloads-traffic-notice] parse", JSON.stringify({ wire, parsed: parsed.traffic }));
      expect(parsed.traffic).toBe(want);
    }
  });
});

describe("Downloads screen traffic notice", () => {
  /** @req STOR-BW-01[badger-mobile] */
  it("high traffic while a download is active shows the slower notice", () => {
    for (const status of ["queued", "downloading", "waiting_network"] as const) {
      expect(trafficNoticeKey(state("slowed", status))).toBe("downloads.trafficSlowed");
    }
  });

  /** @req STOR-BW-09[badger-mobile] */
  it("a saturated silo shows the on-hold notice, which wins over slower", () => {
    expect(trafficNoticeKey(state("held", "downloading"))).toBe("downloads.trafficHeld");
    expect(trafficNoticeKey(state("held", "queued", "completed"))).toBe("downloads.trafficHeld");
  });

  it("shows nothing at normal traffic, with no active download, or with an empty list", () => {
    expect(trafficNoticeKey(state("normal", "downloading"))).toBeNull();
    expect(trafficNoticeKey(state("held", "completed", "failed"))).toBeNull();
    expect(trafficNoticeKey(state("slowed"))).toBeNull();
  });

  /** @req STOR-BW-01[badger-mobile] */
  it("the slower notice reads as the product wording in English and French", () => {
    console.info("[downloads-traffic-notice] strings", en.downloads.trafficSlowed, "|", fr.downloads.trafficSlowed);
    expect(en.downloads.trafficSlowed).toBe("Downloads are slower because we're in a high-traffic period.");
    expect(fr.downloads.trafficSlowed).toBe("Les téléchargements sont plus lents car nous sommes en période de fort trafic.");
  });

  /** @req STOR-BW-09[badger-mobile] */
  it("the on-hold notice says downloads resume on their own, in both languages, and neither names the evening", () => {
    expect(en.downloads.trafficHeld).toMatch(/on hold/);
    expect(en.downloads.trafficHeld).toMatch(/resume on their own/);
    expect(fr.downloads.trafficHeld).toMatch(/suspendus/);
    expect(fr.downloads.trafficHeld).toMatch(/reprennent d'eux-mêmes/);
    for (const text of [en.downloads.trafficSlowed, en.downloads.trafficHeld, fr.downloads.trafficSlowed, fr.downloads.trafficHeld]) {
      expect(text).not.toMatch(/evening|soir/i);
    }
  });
});
