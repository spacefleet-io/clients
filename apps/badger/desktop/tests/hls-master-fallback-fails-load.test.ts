// @bugfix @regression-proof issue #25 P8 residual — "first visible frame at
// 0:00 while a start is pending" (confirm run seed 1791373829836, S1 x002).
//
// Evidence (results root …/sharded-2026-10-07T11-50-34-327Z-1791373829836):
//   shard-1/logs/playback-server.jsonl  session c35a91ea: video init
//     ab2d4555 (isInit:true) → object.fetch.retry ×2 → object.error
//     TUNNEL_DOWNLOAD_ERROR_download_source_missing → HTTP 500  (P16 data loss)
//   shard-1/logs/mpv-12-1791384078899.log:505-529
//     hls: Failed to open an initialization section in playlist 3
//     avformat_open_input() failed → playlist demuxer → "Stream is not seekable"
//     finished playback, success (reason 5 = redirect)
//     Playing: …/video-f94438d3….m3u8   ← video only, start=23.33 ignored
//   timeline.jsonl: "end-file: forwarding to renderer" reason=redirect.
//   Every redirect in the run (18/18/4 per shard) matches a source_missing.
//
// Pre-fix the renderer saw the redirect and called it "not a load failure":
// playback "succeeded" from 0:00 with no audio. Post-fix, every load path
// treats it as a failed load. It is logged at error level and mpv is stopped,
// so the user sees the normal playback-failed message.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MpvExternalMessage } from "@space/mpv-protocol";
import { watchHlsMasterFallback } from "../src/renderer/src/lib/hlsMasterFallbackWatch";

const LOG = "[hls-master-fallback-fails-load]";

const fakeBus = () => {
  const listeners = new Set<(msg: MpvExternalMessage) => void>();
  return {
    listeners,
    subscribe: (callback: (msg: MpvExternalMessage) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit: (msg: MpvExternalMessage) => {
      for (const listener of listeners) listener(msg);
    },
  };
};

describe("HLS master fallback fails the load (@bugfix @regression-proof issue #25 P8)", () => {
  it("replays x002: the reload's end-file stop is ignored, the master's redirect fails the load", async () => {
    const bus = fakeBus();
    const seen: string[] = [];
    const watch = watchHlsMasterFallback(bus.subscribe, (info) => {
      seen.push(`${info.reason}:${info.verdict.failed}`);
      console.info(`${LOG} end-file ${JSON.stringify(info)}`);
    });
    expect(watch.current()).toBeNull();

    // `loadfile … replace` ends the previous file first.
    bus.emit({ type: "end_file", reason: "stop", fileError: null } as MpvExternalMessage);
    expect(watch.current()).toBeNull();

    // mpv-12 log :505-529: master open failed → playlist demuxer → redirect.
    bus.emit({ type: "end_file", reason: "redirect", fileError: null } as MpvExternalMessage);
    const current = watch.current();
    console.info(`${LOG} current=${JSON.stringify(current)} seen=${JSON.stringify(seen)}`);
    expect(current).toMatchObject({ failed: true, cause: "hls_master_fallback" });
    // The race side resolves with the same verdict (awaited only once it is known to be set).
    expect(await watch.failure).toEqual(current);
    expect(seen).toEqual(["stop:false", "redirect:true"]);

    watch.stop();
    expect(bus.listeners.size).toBe(0);
  });

  it("ignores every non-fallback end-file and other messages (exit path owns reason=error on a direct launch)", () => {
    const bus = fakeBus();
    const watch = watchHlsMasterFallback(bus.subscribe);
    for (const reason of ["eof", "stop", "quit", "error", null]) {
      bus.emit({ type: "end_file", reason, fileError: reason === "error" ? "loading failed" : null } as MpvExternalMessage);
    }
    bus.emit({ type: "script_message", name: "sf-track-picked", args: ["aid", "2"] } as MpvExternalMessage);
    console.info(`${LOG} non-fallback current=${JSON.stringify(watch.current())}`);
    expect(watch.current()).toBeNull();
    watch.stop();
  });

  it("works without a preload bridge (no subscribe): nothing seen, stop is safe", () => {
    const watch = watchHlsMasterFallback(undefined);
    console.info(`${LOG} no-bridge current=${JSON.stringify(watch.current())}`);
    expect(watch.current()).toBeNull();
    expect(() => watch.stop()).not.toThrow();
  });

  it("the engine races the watch in the direct launch and the reload, and checks it again before success", () => {
    const src = readFileSync(resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const wiring = {
      arms: (src.match(/fallbackWatch = watchHlsMasterFallback\(window\.sf\?\.onMpvExternalMessage/g) ?? []).length,
      directRace: /Promise\.race\(\[\s*Promise\.all\(\[tracksStablePromise, metadataPromise\]\)\.then\([^\n]*\),\s*\.\.\.\(fallbackWatch \? \[fallbackWatch\.failure\] : \[\]\),/.test(src),
      reloadRace: /Promise\.race\(\[\s*Promise\.all\(\[reloadTracksStablePromise, reloadMetadataPromise\]\)\.then\([^\n]*\),\s*fallbackWatch\.failure,/.test(src),
      lateChecks: (src.match(/Fallback = fallbackWatch\??\.current\(\);/g) ?? []).length,
      failCalls: (src.match(/await failOnHlsMasterFallback\(/g) ?? []).length,
      errorLevel: /mpvLog\.error\(\{\s*branch,\s*verdict,/.test(src),
      stopsMpv: /stopExternalMpv after HLS master fallback failed/.test(src),
      disarmed: /\} finally \{\s*fallbackWatch\?\.stop\(\);/.test(src),
    };
    console.info(`${LOG} engine wiring ${JSON.stringify(wiring)}`);
    expect(wiring).toEqual({
      arms: 2,
      directRace: true,
      reloadRace: true,
      lateChecks: 2,
      failCalls: 4,
      errorLevel: true,
      stopsMpv: true,
      disarmed: true,
    });
  });
});
