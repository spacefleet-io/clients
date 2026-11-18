/**
 * @test-id MOBILE-PLAYBACK-RUNG-SWITCH-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * A rung switch on mobile is a reload of that rung's own master at the current position (lavf's HLS demuxer exposes ONE video
 * track per master, so `vid` can never address the other rungs). The decisions live in `@space/playback-abr`; this file pins
 * the mobile-side URL and restore plumbing.
 */
import { describe, expect, it } from "vitest";
import { buildSwitchLoadOptions, planSwitchRestore, rungMasterUrl, SWITCH_ONE_SEGMENT_AT_A_TIME } from "../src/lib/playback/rungSwitch";

describe("switch restore", () => {
  const frame = { voConfigured: true };

  it("keeps position, audio/sub ids and pause state", () => {
    expect(planSwitchRestore({ position: 123.4, paused: true, aid: 2, sid: 3, ...frame })).toEqual({ startSeconds: 123.4, aid: 2, sid: 3, paused: true });
    expect(planSwitchRestore({ position: -1, paused: false, aid: 0, sid: 4, ...frame })).toEqual({ startSeconds: 0, aid: null, sid: 4, paused: false });
  });

  /** @req PLAY-TRACK-03[badger-mobile,badger-tv] */
  it("passes sid=no when the viewer chose subtitles Off, so the reload does not bring a track back", () => {
    // mpv reports no `sid` (native maps it to 0 or -1) once subtitles are Off.
    for (const sid of [0, -1, null]) {
      const restore = planSwitchRestore({ position: 50, paused: false, aid: 2, sid, ...frame });
      const options = buildSwitchLoadOptions(restore, false);
      console.info(`[switch-restore] sid=${sid} -> ${JSON.stringify(restore)} options="${options}"`);
      expect(restore.sid).toBe("no");
      expect(options).toBe("aid=2,sid=no");
    }
  });

  /** @req PLAY-TRACK-03[badger-mobile,badger-tv] */
  it("keeps the picked audio and subtitle ids in the reload options", () => {
    const options = buildSwitchLoadOptions(planSwitchRestore({ position: 50, paused: true, aid: 3, sid: 5, ...frame }), false);
    console.info(`[switch-restore] options="${options}"`);
    expect(options).toBe("aid=3,sid=5,pause=yes");
  });

  /** @req PLAY-TRACK-03[badger-mobile,badger-tv] */
  it("never reads a missing sid as Off before a frame is up (mpv reports no ids then)", () => {
    const restore = planSwitchRestore({ position: 0, paused: false, aid: -1, sid: -1, voConfigured: false });
    expect(restore).toEqual({ startSeconds: 0, aid: null, sid: null, paused: false });
    expect(buildSwitchLoadOptions(restore, false)).toBe("");
  });

  /** @req PLAY-TRACK-03[badger-mobile,badger-tv] */
  it("re-adds an active sidecar subtitle instead of restoring its sid, which no longer exists after the reload", () => {
    const restore = planSwitchRestore({ position: 50, paused: false, aid: 2, sid: 7, ...frame });
    expect(buildSwitchLoadOptions(restore, true)).toBe("aid=2");
  });

  /** @req PLAY-ABR-04[badger-mobile] */
  it("a pending start wins over the reported position (mpv reports 0 until the start seek lands)", () => {
    expect(planSwitchRestore({ position: 0, paused: false, aid: 1, sid: 0, voConfigured: false }, 39.5).startSeconds).toBe(39.5);
    expect(planSwitchRestore({ position: 12, paused: false, aid: 1, sid: 0, ...frame }, null).startSeconds).toBe(12);
  });

  /**
   * @bugfix @regression-proof OnePlus 6 test phone `abr-recovery` (2026-11-13): the reload at 83.6 s had the whole 420p segment at 83.4 s
   * in the proxy, yet the first 420p frame waited 31 s for the next one. lavf's HLS demuxer (`http_multiple`, on for an
   * HTTP/1.1 server) opens segment k+1 right after k, before reading any of k, and the open waits for the response
   * headers, which the Android proxy sends only once the whole object is fetched. Desktop mpv 0.41 on the same 420p
   * segments, k+1 held 20 s: first frame after 20.03 s by default, after 0.03 s with `http_multiple=0`.
   */
  /** @req PLAY-ABR-04[badger-mobile] */
  it("a reload through the Android proxy has lavf open one segment at a time; the default keeps lavf's own choice", () => {
    const restore = planSwitchRestore({ position: 83.6, paused: false, aid: 1, sid: 0, ...frame });
    const proxied = buildSwitchLoadOptions(restore, false, true);
    console.info(`[switch-restore] proxied options="${proxied}"`);
    expect(SWITCH_ONE_SEGMENT_AT_A_TIME).toBe("demuxer-lavf-o-append=http_multiple=0");
    expect(proxied).toBe("aid=1,sid=no,demuxer-lavf-o-append=http_multiple=0");
    expect(buildSwitchLoadOptions(restore, false)).toBe("aid=1,sid=no");
  });
});

/**
 * @bugfix @regression-proof lavf's HLS demuxer exposes ONE video track per master (the highest-bandwidth variant, or the
 * `hls-bitrate` pick), so `vid` can never address the other rungs: the app picks a rung by loading that rung's own master.
 */
describe("rungMasterUrl", () => {
  const url = "http://127.0.0.1:40547/playback/hls/4bb5b7c2/master.m3u8";
  it("points at the single-rung master of the variant", () => {
    const rung = rungMasterUrl(url, "c51db004-bba5");
    console.info(`[rung-master] ${url} -> ${rung}`);
    expect(rung).toBe("http://127.0.0.1:40547/playback/hls/4bb5b7c2/master-c51db004-bba5.m3u8");
  });
  it("rejects a url that is not a session master", () => {
    expect(() => rungMasterUrl("http://127.0.0.1:1/playback/hls/x/video-a.m3u8", "a")).toThrow();
  });
});
