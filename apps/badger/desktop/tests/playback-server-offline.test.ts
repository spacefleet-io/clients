// @bugfix offline-playback-ignored-local-file
// @regression-proof
// @req OFFL-FILE-03[badger-desktop]
//
// Integration tests for offline playback on PlaybackServer: an HLS session built from the manifest of an item saved
// as sealed pieces (SFV1 objects inside the app's offline dir), the same HLS path as streaming. Every listed piece is
// served from the device: read, decrypted, Range honoured, with no tunnel and no auth token, so playback works with the
// backend/runtime unreachable. The manifest path comes from the runtime's list_local and must sit in an offline root.
//
// These tests spin the real http server (PlaybackServer.start binds a port) and fetch against it, mirroring
// playback-server.test.ts — including its graceful handling of sandboxed CI where listen() throws EPERM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const downloadToSinkMock = vi.hoisted(() => vi.fn());
vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { getDesktopPlatform } from "@space/desktop-platform";
import {
  OFFLINE_PIECES_MANIFEST_VERSION,
  offlinePiecePath,
  writeOfflinePiece,
  writeOfflinePieceManifest,
} from "@space/library-db-runtime/offlinePieceStore";
import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";
import { deriveMediaMasterKey, encryptMediaObject, setMediaMasterKey } from "../src/main/mediaCrypto";

const SUITE = "playback-server-offline";
const FILE_ID = "file-bn99-s1e1";

// Deterministic plaintexts so range math is easy to assert.
const plain = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_u, i) => (i + seed) % 256));
const PIECES = {
  "v-init": plain(300, 1),
  "v-chunk-0": plain(1000, 2),
  "v-chunk-1": plain(800, 3),
  "a-init": plain(200, 4),
  "a-chunk-0": plain(600, 5),
  "sub-en": Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n"),
} as const;

/** Seals every piece (SFV1) into the store under `root`, then writes the manifest. Returns the manifest path. */
const saveItem = async (root: string): Promise<string> => {
  const objects: Array<{ key: string; sizeBytes: number }> = [];
  for (const [key, bytes] of Object.entries(PIECES)) {
    const sealed = encryptMediaObject(bytes);
    await writeOfflinePiece(root, key, sealed);
    objects.push({ key, sizeBytes: sealed.length });
  }
  const manifestPath = await writeOfflinePieceManifest(root, {
    version: OFFLINE_PIECES_MANIFEST_VERSION,
    fileId: FILE_ID,
    mediaId: "media-bn99",
    formatId: "format-720",
    quality: "720p",
    savedAt: "2026-11-21T00:00:00.000Z",
    video: {
      id: "format-720",
      quality: "720p",
      bitrateKbps: 2500,
      track: {
        initKey: "v-init",
        codecString: "avc1.64001f",
        durationSeconds: 10,
        chunks: [
          { key: "v-chunk-0", sizeBytes: 0, startSeconds: 0 },
          { key: "v-chunk-1", sizeBytes: 0, startSeconds: 6 },
        ],
      },
    },
    audio: [
      {
        id: "audio-en",
        language: "en",
        label: "English",
        isDefault: true,
        track: {
          initKey: "a-init",
          codecString: "mp4a.40.2",
          durationSeconds: 10,
          chunks: [{ key: "a-chunk-0", sizeBytes: 0, startSeconds: 0 }],
        },
      },
    ],
    subtitles: [{ id: "sub-en", language: "en", label: "English", format: "srt", objectKey: "sub-en", isDefault: true }],
    objects,
    totalBytes: objects.reduce((sum, o) => sum + o.sizeBytes, 0),
  });
  console.info(`[${SUITE}:fixture] saved ${objects.length} sealed pieces, manifest=${manifestPath}`);
  return manifestPath;
};

const objectUrl = (base: string, key: string) => `${base}/playback/object/${encodeURIComponent(key)}`;

describe("playbackServer offline pieces session", () => {
  let server: PlaybackServer;
  let startError: unknown = null;
  let tmpDir: string;
  let root: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    downloadToSinkMock.mockReset();
    downloadToSinkMock.mockRejectedValue(new Error("network_down"));
    setMediaMasterKey(deriveMediaMasterKey(randomBytes(32)));
    tmpDir = mkdtempSync(join(tmpdir(), "sf-offline-pb-"));
    savedEnv.SF_BADGER_OFFLINE_DIR = process.env.SF_BADGER_OFFLINE_DIR;
    process.env.SF_BADGER_OFFLINE_DIR = tmpDir;
    root = join(tmpDir, "default");
    mkdirSync(root, { recursive: true });

    startError = null;
    server = new PlaybackServer();
    try {
      await server.start();
    } catch (error) {
      startError = error;
    }
    console.info(`[${SUITE}:setup] startError=${String(startError)} base=${server.getBaseUrl()} root=${root}`);
  });

  afterEach(async () => {
    if (server) await server.stop();
    setMediaMasterKey(null);
    setActivePlaybackProfileId(null);
    if (savedEnv.SF_BADGER_OFFLINE_DIR === undefined) delete process.env.SF_BADGER_OFFLINE_DIR;
    else process.env.SF_BADGER_OFFLINE_DIR = savedEnv.SF_BADGER_OFFLINE_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const skipIfSandboxed = (): boolean => {
    if (startError) {
      // Sandboxed CI cannot bind a socket — assert the known errno and skip.
      expect((startError as { code?: string }).code).toBe("EPERM");
      return true;
    }
    return false;
  };

  it("builds an HLS session from the manifest: saved quality, audio track, segment durations, subtitle keys", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    const session = await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    const base = server.getBaseUrl()!;
    const master = await (await fetch(session.url)).text();
    const videoPlaylistUrl = master.split("\n").find((line) => line && !line.startsWith("#"));
    const videoPlaylist = videoPlaylistUrl ? await (await fetch(new URL(videoPlaylistUrl, session.url))).text() : "";
    console.info(`[${SUITE}:hls] session`, session);
    console.info(`[${SUITE}:hls] master\n${master}\n[${SUITE}:hls] video playlist\n${videoPlaylist}`);
    expect(session.subtitleKeys).toEqual(["sub-en"]);
    expect(master).toContain("EXT-X-MEDIA:TYPE=AUDIO");
    expect(master).toContain("English");
    // 6 s + 4 s chunks; video boundaries are announced HLS_VIDEO_SEEK_LEAD_SECONDS (0.25) early, the total stays 10 s.
    expect(videoPlaylist).toContain("#EXTINF:5.750,");
    expect(videoPlaylist).toContain("#EXTINF:4.250,");
    expect(videoPlaylist).toContain(objectUrl(base, "v-chunk-0"));
  });

  it("serves each saved piece decrypted from the device, with no token and the tunnel never called", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    const base = server.getBaseUrl()!;
    const served: Record<string, boolean> = {};
    for (const [key, bytes] of Object.entries(PIECES)) {
      const res = await fetch(objectUrl(base, key));
      const body = Buffer.from(await res.arrayBuffer());
      served[key] = res.status === 200 && body.equals(bytes);
    }
    console.info(`[${SUITE}:serve] served`, served, { tunnelCalls: downloadToSinkMock.mock.calls.length });
    expect(Object.values(served).every(Boolean)).toBe(true);
    expect(downloadToSinkMock).not.toHaveBeenCalled();
  });

  it("honours a Range request with 206 + Content-Range over the decrypted bytes", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    const res = await fetch(objectUrl(server.getBaseUrl()!, "v-chunk-0"), { headers: { Range: "bytes=100-199" } });
    const body = Buffer.from(await res.arrayBuffer());
    console.info(`[${SUITE}:range] status=${res.status} contentRange=${res.headers.get("content-range")} len=${body.length}`);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${PIECES["v-chunk-0"].length}`);
    expect(body.equals(PIECES["v-chunk-0"].subarray(100, 200))).toBe(true);
    expect(downloadToSinkMock).not.toHaveBeenCalled();
  });

  it("prewarm reads the local pieces (no tunnel)", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    const session = await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    const warm = await server.prewarmHlsSession(session.id, { startSeconds: 7 });
    console.info(`[${SUITE}:prewarm] result`, warm);
    expect(warm.missedKeys).toEqual([]);
    expect(warm.warmedKeys.sort()).toEqual(["a-chunk-0", "a-init", "v-chunk-1", "v-init"]);
    expect(downloadToSinkMock).not.toHaveBeenCalled();
  });

  it("a key that is not saved here still needs the token", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    const res = await fetch(objectUrl(server.getBaseUrl()!, "streamed-only-chunk"));
    console.info(`[${SUITE}:token] status=${res.status}`);
    expect(res.status).toBe(401);
  });

  it("a piece removed after the session opened falls back to the tunnel (which is down here)", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
    server.setToken("token");
    // STOR-BW-11: a tunnel fetch names the playback profile; without one it refuses before the network.
    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    rmSync(offlinePiecePath(root, "v-chunk-1"));
    const res = await fetch(objectUrl(server.getBaseUrl()!, "v-chunk-1"));
    console.info(`[${SUITE}:gone] status=${res.status} tunnelCalls=${downloadToSinkMock.mock.calls.length}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(downloadToSinkMock).toHaveBeenCalled();
  });

  it("rejects a missing manifest and one naming another file", async () => {
    if (skipIfSandboxed()) return;
    const manifestPath = await saveItem(root);
    await expect(
      server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath: join(root, "items", "nope.json") }),
    ).rejects.toThrow(/offline_file_missing/);
    await expect(server.createOfflineHlsSession({ fileId: "file-other", manifestPath })).rejects.toThrow(
      /offline_file_missing/,
    );
  });

  it("rejects a manifest path outside every offline root", async () => {
    if (skipIfSandboxed()) return;
    const outside = mkdtempSync(join(tmpdir(), "sf-offline-evil-"));
    try {
      const evil = join(outside, "items", "x.json");
      mkdirSync(join(outside, "items"), { recursive: true });
      writeFileSync(evil, "{}");
      await expect(server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath: evil })).rejects.toThrow(
        /offline_path_outside_root/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("@bugfix @regression-proof default runtime data dir root (runtime data dir moved off /tmp)", () => {
    const saved: Record<string, string | undefined> = {};
    // Every OS's home for the default data dir (Linux XDG_DATA_HOME, macOS HOME -> ~/Library, Windows
    // LOCALAPPDATA) points at a temp dir, so the test never writes into the real one.
    const KEYS = ["SF_BADGER_OFFLINE_DIR", "SPACEFLEET_RUNTIME_DATA_DIR", "XDG_DATA_HOME", "HOME", "LOCALAPPDATA"] as const;
    let xdg: string;
    beforeEach(() => {
      for (const key of KEYS) saved[key] = process.env[key];
      xdg = mkdtempSync(join(tmpdir(), "sf-offline-xdg-"));
      process.env.SF_BADGER_OFFLINE_DIR = join(tmpDir, "elsewhere"); // does NOT contain the paths below
      delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
      process.env.XDG_DATA_HOME = xdg;
      process.env.HOME = xdg;
      process.env.LOCALAPPDATA = xdg;
    });
    afterEach(() => {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(xdg, { recursive: true, force: true });
    });

    it("accepts an item saved under the runtime's default data dir", async () => {
      if (skipIfSandboxed()) return;
      const offlineDefault = join(getDesktopPlatform().paths.runtimeDataDir(process.env), "offline", "default");
      expect(offlineDefault.startsWith(xdg)).toBe(true);
      const manifestPath = await saveItem(offlineDefault);
      console.info(`[${SUITE}:default-root] serving`, { manifestPath });
      const session = await server.createOfflineHlsSession({ fileId: FILE_ID, manifestPath });
      expect((await fetch(session.url)).status).toBe(200);
    });

    it("rejects a path under the legacy shared /tmp/spacefleet-runtime", async () => {
      if (skipIfSandboxed()) return;
      // Containment is checked before the manifest is read, so nothing needs to exist under /tmp.
      await expect(
        server.createOfflineHlsSession({
          fileId: FILE_ID,
          manifestPath: "/tmp/spacefleet-runtime/offline/default/items/x.json",
        }),
      ).rejects.toThrow(/offline_path_outside_root/);
    });
  });
});
