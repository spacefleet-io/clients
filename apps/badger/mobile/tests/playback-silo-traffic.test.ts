/**
 * @test-id MOBILE-PLAYBACK-SILO-TRAFFIC-001
 * @level unit
 *
 * A saturated silo (STOR-BW-07, STOR-BW-08, PLAY-QUAL-07): the player reads that one silo's traffic report, steps Auto down to
 * the cap, stops a free viewer that has no rung at or under 480p, and names a refusal or a stop in plain words (no pause, no
 * automatic resume).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Variant } from "@space/playback-abr";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import en from "@space/mobile-shell/i18n/en.json";
import fr from "@space/mobile-shell/i18n/fr.json";
import {
  TRAFFIC_POLL_MS,
  activeQualityCap,
  applySiloTrafficEvent,
  fetchSiloTraffic,
  parseSiloTrafficEvent,
  planCapRelease,
  planCapStep,
  trafficPollDue,
} from "../src/lib/playback/siloTraffic";

const traffic = (over: Partial<StorageTraffic> = {}): StorageTraffic => ({
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
  ...over,
});

const variant = (id: string, quality: string): Variant => ({
  id,
  quality,
  codec: "h264",
  codecString: "avc1.640028",
  bitrateKbps: null,
  width: null,
  height: null,
});

const ladder = [variant("v2160", "2160p"), variant("v1080", "1080p"), variant("v480", "480p")];

afterEach(() => vi.unstubAllGlobals());

describe("quality cap", () => {
  /** @req PLAY-QUAL-07 */
  it("applies only while the silo is saturated", () => {
    expect(activeQualityCap(traffic())).toBe("480p");
    expect(activeQualityCap(traffic({ saturated: false }))).toBeNull();
    expect(activeQualityCap(null)).toBeNull();
  });

  /** @req PLAY-QUAL-07 */
  it("steps a free viewer down to the best rung at or under 480p", () => {
    expect(planCapStep(ladder, "v2160", "480p")).toEqual({ target: { kind: "switch", id: "v480" }, limited: true });
  });

  /** @req PLAY-QUAL-07 */
  it("leaves a rung already at the cap alone but still reports the limit", () => {
    expect(planCapStep(ladder, "v480", "480p")).toEqual({ target: null, limited: true });
  });

  /** @req STOR-BW-07[badger-mobile] */
  it("stops a free viewer when the media has no rung at or under 480p", () => {
    const high = ladder.slice(0, 2);
    expect(planCapStep(high, "v1080", "480p").target).toEqual({ kind: "stop" });
  });

  /** @req PLAY-QUAL-07 */
  it("steps a Starter or Standard viewer down to 1080p and never stops one", () => {
    expect(planCapStep(ladder, "v2160", "1080p").target).toEqual({ kind: "switch", id: "v1080" });
    const only4k = [variant("v2160", "2160p")];
    expect(planCapStep(only4k, "v2160", "1080p")).toEqual({ target: null, limited: false });
  });
});

/** What the native proxy's `SpacePlaybackTraffic` event carries: the gateway's own words (status, error code, traffic object). */
const native = (over: Record<string, unknown>) => JSON.stringify({ source: "session", status: 200, code: null, traffic: null, ...over });
const wire = (over: Record<string, unknown> = {}) => ({
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
  ...over,
});

describe("native traffic events (what the gateway really said)", () => {
  /** @req STOR-BW-07[badger-mobile] */
  it("reads the 503 free_playback_refused of a session open, with the silo's report", () => {
    const event = parseSiloTrafficEvent(native({ status: 503, code: "free_playback_refused", traffic: wire() }));
    console.log("refused event", JSON.stringify(event));
    expect(event).toEqual({ kind: "refused", traffic: traffic() });
  });

  /** @req STOR-BW-08 */
  it("reads the 503 playback_stopped of a download, with the silo's report", () => {
    const event = parseSiloTrafficEvent(native({ source: "download", status: 503, code: "playback_stopped", traffic: wire({ playbackStopped: true }) }));
    console.log("stopped event", JSON.stringify(event));
    expect(event).toEqual({ kind: "stopped", traffic: traffic({ playbackStopped: true }) });
  });

  /** @req STOR-BW-08 */
  it("reads the traffic of a session response and of a session.ack as a plain report", () => {
    expect(parseSiloTrafficEvent(native({ source: "ack", traffic: wire() }))).toEqual({ kind: "report", traffic: traffic() });
    expect(parseSiloTrafficEvent(native({ source: "session", traffic: wire({ saturated: false, qualityCap: null, state: "normal" }) }))).toEqual({
      kind: "report",
      traffic: traffic({ saturated: false, qualityCap: null, state: "normal", playbackBufferSeconds: null }),
    });
  });

  it("keeps a refusal or a stop even when the body carried no readable report", () => {
    expect(parseSiloTrafficEvent(native({ status: 503, code: "free_playback_refused" }))).toEqual({ kind: "refused", traffic: null });
    expect(parseSiloTrafficEvent(native({ status: 503, code: "playback_stopped", traffic: "junk" }))).toEqual({ kind: "stopped", traffic: null });
  });

  it("ignores what the gateway did not say about traffic: other errors, old gateways, junk", () => {
    expect(parseSiloTrafficEvent(native({ status: 503, code: "overloaded" }))).toBeNull();
    expect(parseSiloTrafficEvent(native({ status: 402, code: "subscription_unpaid", traffic: wire() }))).toBeNull();
    expect(parseSiloTrafficEvent(native({ source: "ack" }))).toBeNull();
    expect(parseSiloTrafficEvent("not json")).toBeNull();
    expect(parseSiloTrafficEvent(42)).toBeNull();
    expect(parseSiloTrafficEvent(null)).toBeNull();
  });

  it("accepts the payload as an object too (iOS delivers a dictionary)", () => {
    expect(parseSiloTrafficEvent({ source: "ack", status: 200, code: null, traffic: wire() })).toEqual({ kind: "report", traffic: traffic() });
  });
});

describe("what a native event changes", () => {
  /** @req STOR-BW-07[badger-mobile] */
  it("a refusal names the refusal, from the gateway's answer and never from a guess", () => {
    const next = applySiloTrafficEvent(null, { kind: "refused", traffic: traffic() });
    expect(next).toEqual({ traffic: traffic(), unavailable: "freePlaybackRefused" });
  });

  /** @req STOR-BW-07[badger-mobile] */
  it("a refusal without a readable report keeps the last report", () => {
    const previous = traffic({ saturated: false, qualityCap: null });
    expect(applySiloTrafficEvent(previous, { kind: "refused", traffic: null })).toEqual({ traffic: previous, unavailable: "freePlaybackRefused" });
  });

  /** @req STOR-BW-08 */
  it("a stop is a stop even when the report forgot to say the viewer was stopped", () => {
    const next = applySiloTrafficEvent(null, { kind: "stopped", traffic: traffic({ playbackStopped: false }) });
    expect(next.unavailable).toBe("playbackStopped");
    expect(next.traffic?.playbackStopped).toBe(true);
  });

  /** @req STOR-BW-08 */
  it("a stop whose report carries no cap keeps the cap it had, so nothing reads it as the cap lifting", () => {
    // The gateway's 503 `playback_stopped` reports the silo without the plan's cap (`qualityCap: null`).
    const capped = traffic();
    const next = applySiloTrafficEvent(capped, { kind: "stopped", traffic: traffic({ qualityCap: null, playbackStopped: true }) });
    console.log("stop without cap", JSON.stringify(next));
    expect(next.unavailable).toBe("playbackStopped");
    expect(activeQualityCap(next.traffic)).toBe("480p");
    const lastRung = { displacedId: "v1080", capTargetId: "v480" };
    expect(planCapRelease(ladder, { mode: "manual", currentId: "v480" }, lastRung, activeQualityCap(next.traffic), false)).toEqual({
      restoreTo: null,
      displaced: lastRung,
    });
  });

  /** @req STOR-BW-08 */
  it("a report with the cap hands the cap over; a report that stops the viewer stops it", () => {
    expect(applySiloTrafficEvent(null, { kind: "report", traffic: traffic() })).toEqual({ traffic: traffic(), unavailable: null });
    expect(activeQualityCap(applySiloTrafficEvent(null, { kind: "report", traffic: traffic() }).traffic)).toBe("480p");
    expect(applySiloTrafficEvent(null, { kind: "report", traffic: traffic({ playbackStopped: true }) }).unavailable).toBe("playbackStopped");
  });

  /** @req STOR-BW-07[badger-mobile] */
  it("a later quiet report lifts the cap again", () => {
    const capped = applySiloTrafficEvent(null, { kind: "report", traffic: traffic() });
    const lifted = applySiloTrafficEvent(capped.traffic, { kind: "report", traffic: traffic({ saturated: false, qualityCap: null, state: "normal" }) });
    expect(activeQualityCap(lifted.traffic)).toBeNull();
    expect(lifted.unavailable).toBeNull();
  });
});

describe("the poll is only the fallback", () => {
  it("polls when no native report was heard, or none within the poll interval", () => {
    expect(trafficPollDue(null, 1_000)).toBe(true);
    expect(trafficPollDue(1_000, 1_000 + TRAFFIC_POLL_MS - 1)).toBe(false);
    expect(trafficPollDue(1_000, 1_000 + TRAFFIC_POLL_MS)).toBe(true);
  });
});

describe("stepping back up when the cap lifts", () => {
  const lastRung = { displacedId: "v1080", capTargetId: "v480" };

  /** @req STOR-BW-08 */
  it("a pinned rung the cap displaced comes back once the cap is gone", () => {
    expect(planCapRelease(ladder, { mode: "manual", currentId: "v480" }, lastRung, null, false)).toEqual({ restoreTo: "v1080", displaced: null });
  });

  /** @req STOR-BW-08 */
  it("Auto climbs by itself (its ceiling is back): nothing to restore, the record is dropped", () => {
    expect(planCapRelease(ladder, { mode: "auto", currentId: "v480" }, lastRung, null, false)).toEqual({ restoreTo: null, displaced: null });
  });

  it("does nothing while the cap still applies", () => {
    expect(planCapRelease(ladder, { mode: "manual", currentId: "v480" }, lastRung, "480p", false)).toEqual({ restoreTo: null, displaced: lastRung });
  });

  /** @req STOR-BW-08 */
  it("brings nothing back while the player is stopped or failed, even with the cap gone", () => {
    const plan = planCapRelease(ladder, { mode: "manual", currentId: "v480" }, lastRung, null, true);
    console.log("release while failed", JSON.stringify(plan));
    expect(plan).toEqual({ restoreTo: null, displaced: lastRung });
  });

  it("never overrides a rung the viewer picked since", () => {
    expect(planCapRelease(ladder, { mode: "manual", currentId: "v2160" }, lastRung, null, false)).toEqual({ restoreTo: null, displaced: null });
  });

  it("forgets a displaced rung the media no longer has", () => {
    expect(planCapRelease(ladder.slice(1), { mode: "manual", currentId: "v480" }, { ...lastRung, displacedId: "v2160" }, null, false)).toEqual({
      restoreTo: null,
      displaced: null,
    });
  });

  it("has nothing to do when the cap displaced nothing", () => {
    expect(planCapRelease(ladder, { mode: "manual", currentId: "v480" }, null, null, false)).toEqual({ restoreTo: null, displaced: null });
  });
});

describe("fetchSiloTraffic", () => {
  /** @req STOR-BW-07[badger-mobile] */
  it("asks the silo's own /storage/traffic with the account token and walks past an unreachable address", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push(`${url} ${init.headers.Authorization}`);
        if (url.startsWith("http://down")) throw new Error("connect failed");
        return { ok: true, json: async () => ({ traffic: traffic() }) };
      }),
    );
    const report = await fetchSiloTraffic(["http://down:1", "http://silo-a:2"], "tok", "prof-1");
    expect(report).toMatchObject({ saturated: true, qualityCap: "480p", playbackStopped: false });
    expect(calls).toEqual([
      "http://down:1/storage/traffic?profileId=prof-1 Bearer tok",
      "http://silo-a:2/storage/traffic?profileId=prof-1 Bearer tok",
    ]);
  });

  it("answers null when no address gives a readable report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await fetchSiloTraffic(["http://silo-a:2"], "tok", "prof-1")).toBeNull();
  });
});

describe("words", () => {
  /** @req UX-I18N-01 @req UX-I18N-03 */
  it("has English and accented French for the stop, the refusal and the cap notice, with no auto-resume promise", () => {
    expect(fr.player.error.playbackStopped).toContain("été arrêtée");
    expect(fr.player.error.freePlaybackRefused).toContain("pour le moment");
    expect(fr.player.trafficCap.message).toContain("{{quality}}");
    expect(en.player.trafficCap.message).toContain("{{quality}}");
    for (const text of [
      en.player.error.playbackStopped,
      en.player.error.freePlaybackRefused,
      en.player.trafficCap.message,
      fr.player.error.playbackStopped,
      fr.player.error.freePlaybackRefused,
      fr.player.trafficCap.message,
    ]) {
      expect(text).not.toMatch(/evening|soir|resume automatically|reprendra/i);
    }
  });
});
