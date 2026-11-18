/**
 * @test-id MOBILE-CAST-004
 * @level unit
 * @why The cast flow (UX-TV-03, INTG-CAST-01): refuses before anything is served, starts the LAN server behind a fresh
 *   one-time token with ONLY the trimmed metadata, converts the chosen text subtitle to WebVTT, and keeps the phone from
 *   ever playing on its own (MPV-MODEL-02). The native server is a fake that records what it is asked.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { type AudioTrack, type IngestMetadata, type SubtitleTrack, type VideoFormat } from "@space/mobile-mpv-playback";
import { castProfileForModel, airPlayProfile } from "../src/lib/cast/castProfiles";
import { CastTokenIssuer, isCastToken } from "../src/lib/cast/castToken";
import { castErrorCode, prepareCast, type CastServerApi } from "../src/lib/cast/castFlow";

const video: VideoFormat = {
  id: "v1080",
  quality: "1080p",
  codec: "h264",
  codecString: "avc1.640028",
  initKey: "v/init.mp4",
  initSize: 800,
  durationSeconds: 100,
  totalSize: 1000,
  height: 1080,
  width: 1920,
  chunks: [{ key: "v/0.m4s", sizeBytes: 1000, startSeconds: 0, durationSeconds: 100 }],
};
const audio: AudioTrack = {
  id: "en",
  language: "en",
  label: "English",
  isDefault: true,
  codec: "aac",
  codecString: "mp4a.40.2",
  initKey: "a/init.mp4",
  initSize: 700,
  durationSeconds: 100,
  totalSize: 500,
  chunks: [{ key: "a/0.m4s", sizeBytes: 500, startSeconds: 0, durationSeconds: 100 }],
};
const textSub: SubtitleTrack = { id: "s-en", language: "en", label: "English", isDefault: false, format: "vtt", encrypted: true, url: "subs-en/eng.vtt" };
const pgsSub: SubtitleTrack = { id: "s-fr", language: "fr", label: "French", isDefault: false, format: "pgs", encrypted: true, url: "subs-fr-pgs/fre.sup" };

const metadata = (over: Partial<IngestMetadata> = {}): IngestMetadata => ({
  encryptionKeyBase64: "AAAA",
  videos: [video],
  audioTracks: [audio],
  subtitleTracks: [textSub, pgsSub],
  chapters: [],
  ...over,
});

type FakeServer = { [K in keyof CastServerApi]: Mock<CastServerApi[K]> };

const fakeServer = (over: Partial<CastServerApi> = {}): FakeServer => {
  const server: FakeServer = {
    start: vi.fn<CastServerApi["start"]>(async (args) => ({
      baseUrl: `http://192.168.0.20:41000/cast/${args.token}`,
      masterUrl: `http://192.168.0.20:41000/cast/${args.token}/playback/hls/s1/master.m3u8`,
      host: "192.168.0.20",
      port: 41000,
    })),
    readText: vi.fn<CastServerApi["readText"]>(async () => "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n"),
    putText: vi.fn<CastServerApi["putText"]>(async () => true),
    stop: vi.fn<CastServerApi["stop"]>(async () => true),
  };
  Object.assign(server, over);
  return server;
};

// The fake records the real bridge arguments, typed by `CastServerApi`.
const startArgs = (server: FakeServer, call: number) => server.start.mock.calls[call]![0];
/** The metadata the server was started with. */
const parseMetadata = (json: string): IngestMetadata => JSON.parse(json);

const source = (meta = metadata()) => ({ metadata: meta, libraryKeyBase64: "KEY", proxyConfig: { clientKind: "offline" as const } });

describe("prepareCast", () => {
  /** @req UX-TV-03[badger-mobile] */
  /** @req INTG-CAST-01[badger-mobile] */
  it("starts the LAN server behind a fresh token with the trimmed metadata and returns the master url", async () => {
    const server = fakeServer();
    const issuer = new CastTokenIssuer();
    const result = await prepareCast({
      source: source(),
      profile: castProfileForModel("Chromecast Ultra"),
      startTracks: { audioIdx: 0, subtitle: { mode: "off" } },
      server,
      issuer,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = startArgs(server, 0);
    expect(isCastToken(args.token)).toBe(true);
    expect(issuer.isValid(args.token)).toBe(true);
    expect(args.libraryKeyBase64).toBe("KEY");
    const sent = parseMetadata(args.metadataJson);
    expect(sent.videos.map((v) => v.id)).toEqual(["v1080"]);
    expect(sent.subtitleTracks).toEqual([]);
    expect(result.masterUrl).toContain(`/cast/${args.token}/`);
    expect(server.putText).not.toHaveBeenCalled();
  });

  /** @req UX-TV-03[badger-mobile] */
  it("converts the chosen text subtitle to WebVTT and serves it in place of the stored file", async () => {
    const server = fakeServer();
    const result = await prepareCast({
      source: source(),
      profile: airPlayProfile(),
      startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 0 } },
      server,
      issuer: new CastTokenIssuer(),
    });
    expect(result.ok && result.subtitleUrl).toBe(`http://192.168.0.20:41000/cast/${startArgs(server, 0).token}/playback/object/subs-en%2Feng.vtt`);
    expect(server.readText).toHaveBeenCalledWith("subs-en/eng.vtt");
    expect(server.putText).toHaveBeenCalledTimes(1);
    const [key, body] = server.putText.mock.calls[0]!;
    expect(key).toBe("subs-en/eng.vtt");
    expect(body.startsWith("WEBVTT")).toBe(true);
    expect(body).toContain("00:00:01.000 --> 00:00:02.500");
    expect(body).toContain("X-TIMESTAMP-MAP=");
  });

  /** @req UX-TV-03[badger-mobile] */
  it("serves an empty WebVTT (and still casts) when the subtitle file cannot be read", async () => {
    const server = fakeServer({ readText: vi.fn(async () => { throw new Error("object_not_found"); }) });
    const result = await prepareCast({
      source: source(),
      profile: airPlayProfile(),
      startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 0 } },
      server,
      issuer: new CastTokenIssuer(),
    });
    expect(result.ok).toBe(true);
    const [, body] = server.putText.mock.calls[0]!;
    expect(body.startsWith("WEBVTT")).toBe(true);
    expect(body).not.toContain("-->");
  });

  /** @req UX-TV-03[badger-mobile] */
  it("refuses an image subtitle before any server is started", async () => {
    const server = fakeServer();
    const result = await prepareCast({
      source: source(),
      profile: castProfileForModel("Chromecast Ultra"),
      startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 1 } },
      server,
      issuer: new CastTokenIssuer(),
    });
    expect(result).toMatchObject({ ok: false, reason: "image-subtitles" });
    expect(server.start).not.toHaveBeenCalled();
  });

  /** @req UX-TV-03[badger-mobile] */
  it("refuses a video the device cannot play (HEVC on an old Chromecast) before any server is started", async () => {
    const server = fakeServer();
    const hevc: VideoFormat = { ...video, id: "v2160", codec: "hevc", codecString: "hvc1.2.4.L150.B0", height: 2160 };
    const result = await prepareCast({
      source: source(metadata({ videos: [hevc] })),
      profile: castProfileForModel("Chromecast"),
      startTracks: { audioIdx: 0, subtitle: { mode: "off" } },
      server,
      issuer: new CastTokenIssuer(),
    });
    expect(result).toMatchObject({ ok: false, reason: "video-unsupported" });
    expect(server.start).not.toHaveBeenCalled();
  });

  /** @req UX-TV-03[badger-mobile] */
  it("signals a castable plan before the server starts (the session launches in parallel), warms from the resume point, and never signals a refusal", async () => {
    const order: string[] = [];
    const server = fakeServer({
      start: vi.fn<CastServerApi["start"]>(async (args) => {
        order.push("server.start");
        return { baseUrl: `http://h/cast/${args.token}`, masterUrl: `http://h/cast/${args.token}/m.m3u8`, host: "h", port: 1 };
      }),
    });
    const onPlanned = vi.fn(() => void order.push("planned"));
    const ok = await prepareCast({
      source: source(),
      profile: castProfileForModel("Chromecast Ultra"),
      startTracks: { audioIdx: 0, subtitle: { mode: "off" } },
      server,
      issuer: new CastTokenIssuer(),
      onPlanned,
      startSeconds: 95,
    });
    console.info("[MOBILE-CAST-004] onPlanned order", JSON.stringify(order));
    expect(ok.ok).toBe(true);
    expect(order).toEqual(["planned", "server.start"]);
    expect(startArgs(server, 0).startSeconds).toBe(95);

    const refusedPlanned = vi.fn();
    const refused = await prepareCast({
      source: source(),
      profile: castProfileForModel("Chromecast Ultra"),
      startTracks: { audioIdx: 0, subtitle: { mode: "track", idx: 1 } },
      server: fakeServer(),
      issuer: new CastTokenIssuer(),
      onPlanned: refusedPlanned,
    });
    expect(refused).toMatchObject({ ok: false, reason: "image-subtitles" });
    expect(refusedPlanned).not.toHaveBeenCalled();
  });

  /** @req UX-TV-03[badger-mobile] */
  it("reports a missing Wi-Fi address and a server failure as distinct errors, and leaves no server behind", async () => {
    const noWifi = fakeServer({ start: vi.fn(async () => { throw new Error("cast_no_wifi: connect to Wi-Fi"); }) });
    const failed = fakeServer({ start: vi.fn(async () => { throw new Error("bind failed"); }) });
    const args = { source: source(), profile: airPlayProfile(), startTracks: { audioIdx: 0, subtitle: { mode: "off" } } as const, issuer: new CastTokenIssuer() };
    const a = await prepareCast({ ...args, server: noWifi });
    const b = await prepareCast({ ...args, server: failed });
    expect(a).toMatchObject({ ok: false, reason: "error", code: "noWifi" });
    expect(b).toMatchObject({ ok: false, reason: "error", code: "serverFailed" });
    expect(noWifi.stop).toHaveBeenCalled();
    expect(failed.stop).toHaveBeenCalled();
  });

  /** @req UX-TV-03[badger-mobile] */
  it("issues a different token for every cast and revokes the previous one", async () => {
    const issuer = new CastTokenIssuer();
    const server = fakeServer();
    const args = { source: source(), profile: airPlayProfile(), startTracks: { audioIdx: 0, subtitle: { mode: "off" } } as const, server, issuer };
    await prepareCast(args);
    await prepareCast(args);
    const [first, second] = [startArgs(server, 0).token, startArgs(server, 1).token];
    expect(first).not.toBe(second);
    expect(issuer.isValid(first!)).toBe(false);
    expect(issuer.isValid(second!)).toBe(true);
  });
});

describe("castErrorCode", () => {
  it("maps native errors to i18n suffixes", () => {
    expect(castErrorCode(new Error("cast_no_wifi: x"))).toBe("noWifi");
    expect(castErrorCode({ code: "cast_server_error", message: "cast_no_wifi" })).toBe("noWifi");
    expect(castErrorCode(new Error("anything else"))).toBe("serverFailed");
  });
});
