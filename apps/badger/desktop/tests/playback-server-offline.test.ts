// @bugfix offline-playback-ignored-local-file
// @regression-proof
//
// Integration tests for the offline-mode playback path on PlaybackServer:
// a range-served session backed by a single locally-downloaded muxed file
// (the portable MKV). This is the server seam that lets offline playback work
// with the backend/runtime unreachable — no chunk/tunnel machinery, no auth
// token. Main resolves the on-disk path from the device-local
// `media_local_downloads` table via the `resolveOfflineFile` hook; the renderer
// only ever names a fileId.
//
// These tests spin the real http server (PlaybackServer.start binds a port) and
// fetch against it, mirroring playback-server.test.ts — including its graceful
// handling of sandboxed CI where listen() throws EPERM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const downloadToSinkMock = vi.hoisted(() => vi.fn());
vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { getDesktopPlatform } from "@space/desktop-platform";
import { PlaybackServer } from "../src/main/playbackServer";

// Deterministic 1000-byte payload so range math is easy to assert.
const PAYLOAD = Buffer.from(
  Array.from({ length: 1000 }, (_unused, i) => i % 256),
);

describe("playbackServer offline-file session", () => {
  let server: PlaybackServer;
  let startError: unknown = null;
  let tmpDir: string;
  let mkvPath: string;
  // The resolver the MAIN process supplies — here a stub mapping fileId → path.
  let registry: Map<string, { localPath: string; container?: string | null }>;

  beforeEach(async () => {
    downloadToSinkMock.mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), "sf-offline-pb-"));
    mkvPath = join(tmpDir, "Brooklyn Nine-Nine - S01E01 - Pilot.mkv");
    writeFileSync(mkvPath, PAYLOAD);
    registry = new Map([["file-bn99-s1e1", { localPath: mkvPath, container: "mkv" }]]);

    startError = null;
    server = new PlaybackServer({
      resolveOfflineFile: ({ fileId }) => registry.get(fileId) ?? null,
    });
    try {
      await server.start();
    } catch (error) {
      startError = error;
    }
    console.info(`[offline-pb:setup] startError=${String(startError)} base=${server.getBaseUrl()}`);
  });

  afterEach(async () => {
    if (server) await server.stop();
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

  it("serves the full local file with the right content-type", async () => {
    if (skipIfSandboxed()) return;
    const created = await server.createOfflineFileSession({
      fileId: "file-bn99-s1e1",
      mediaId: "media-bn99",
    });
    console.info(`[offline-pb:full] session=${JSON.stringify(created)}`);
    expect(created.totalSize).toBe(PAYLOAD.length);
    expect(created.url).toContain("/playback/offline/");

    const res = await fetch(created.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/x-matroska");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(PAYLOAD.length);
    expect(body.equals(PAYLOAD)).toBe(true);
  });

  it("honours a Range request with 206 + Content-Range", async () => {
    if (skipIfSandboxed()) return;
    const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1" });

    const res = await fetch(created.url, { headers: { Range: "bytes=100-199" } });
    console.info(
      `[offline-pb:range] status=${res.status} content-range=${res.headers.get("content-range")}`,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-199/${PAYLOAD.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.equals(PAYLOAD.subarray(100, 200))).toBe(true);
  });

  it("answers HEAD with headers and no body", async () => {
    if (skipIfSandboxed()) return;
    const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1" });
    const res = await fetch(created.url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PAYLOAD.length));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(0);
  });

  it("rejects an unregistered fileId (no offline copy)", async () => {
    if (skipIfSandboxed()) return;
    await expect(
      server.createOfflineFileSession({ fileId: "file-not-downloaded" }),
    ).rejects.toThrow(/offline_file_not_registered/);
  });

  it("rejects when the registered file is missing from disk", async () => {
    if (skipIfSandboxed()) return;
    registry.set("file-ghost", { localPath: join(tmpDir, "does-not-exist.mkv"), container: "mkv" });
    await expect(
      server.createOfflineFileSession({ fileId: "file-ghost" }),
    ).rejects.toThrow(/offline_file_missing/);
  });

  it("404s after the session is released", async () => {
    if (skipIfSandboxed()) return;
    const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1" });
    server.releaseOfflineFileSession(created.id);
    const res = await fetch(created.url);
    expect(res.status).toBe(404);
  });

  it("410s if the file disappears after the session was created", async () => {
    if (skipIfSandboxed()) return;
    const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1" });
    // Simulate the user deleting the offline copy mid-session.
    unlinkSync(mkvPath);
    const res = await fetch(created.url);
    console.info(`[offline-pb:gone] status=${res.status}`);
    expect(res.status).toBe(410);
  });

  it("requires no auth token (offline playback works logged-out / server-down)", async () => {
    if (skipIfSandboxed()) return;
    // Never call setToken — the object/HLS routes would 401, the offline route must not.
    const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1" });
    const res = await fetch(created.url);
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Renderer-supplied localPath + multi-root containment. This is the path that
  // actually runs in production: the library DB is runtime-owned (proxy mode),
  // so main can't resolve via getActiveLibraryDb() — the renderer passes the
  // trusted path from list_local and main validates it is under an offline root.
  // ---------------------------------------------------------------------------

  it("serves a renderer-supplied localPath validated under SF_BADGER_OFFLINE_DIR", async () => {
    if (skipIfSandboxed()) return;
    const prev = process.env.SF_BADGER_OFFLINE_DIR;
    process.env.SF_BADGER_OFFLINE_DIR = tmpDir; // mkvPath lives directly under tmpDir
    try {
      const created = await server.createOfflineFileSession({
        fileId: "file-bn99-s1e1",
        localPath: mkvPath,
      });
      expect(created.url).toContain("/playback/offline/");
      const res = await fetch(created.url);
      expect(res.status).toBe(200);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(PAYLOAD)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SF_BADGER_OFFLINE_DIR;
      else process.env.SF_BADGER_OFFLINE_DIR = prev;
    }
  });

  it("accepts a localPath under a DIFFERENT root than SF_BADGER_OFFLINE_DIR (desktop/runtime dir mismatch)", async () => {
    if (skipIfSandboxed()) return;
    // Mirrors the live bug: SF_BADGER_OFFLINE_DIR (desktop main) pointed one
    // place, but the runtime wrote the file under $SPACEFLEET_RUNTIME_DATA_DIR/
    // offline. Multi-root validation must accept the runtime-dir path.
    const altRoot = mkdtempSync(join(tmpdir(), "sf-offline-rtdir-"));
    const offlineDefault = join(altRoot, "offline", "default");
    mkdirSync(offlineDefault, { recursive: true });
    const altMkv = join(offlineDefault, "Brooklyn Nine-Nine - S01E01 - Pilot.mkv");
    writeFileSync(altMkv, PAYLOAD);
    const prevA = process.env.SF_BADGER_OFFLINE_DIR;
    const prevB = process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    process.env.SF_BADGER_OFFLINE_DIR = join(tmpdir(), "sf-offline-elsewhere");
    process.env.SPACEFLEET_RUNTIME_DATA_DIR = altRoot;
    try {
      const created = await server.createOfflineFileSession({
        fileId: "file-bn99-s1e1",
        localPath: altMkv,
      });
      const res = await fetch(created.url);
      expect(res.status).toBe(200);
    } finally {
      if (prevA === undefined) delete process.env.SF_BADGER_OFFLINE_DIR;
      else process.env.SF_BADGER_OFFLINE_DIR = prevA;
      if (prevB === undefined) delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
      else process.env.SPACEFLEET_RUNTIME_DATA_DIR = prevB;
      rmSync(altRoot, { recursive: true, force: true });
    }
  });

  it("rejects a renderer-supplied localPath outside every offline root", async () => {
    if (skipIfSandboxed()) return;
    const outside = mkdtempSync(join(tmpdir(), "sf-offline-evil-"));
    const evil = join(outside, "secret.mkv");
    writeFileSync(evil, PAYLOAD);
    const prevA = process.env.SF_BADGER_OFFLINE_DIR;
    const prevB = process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    process.env.SF_BADGER_OFFLINE_DIR = tmpDir; // does NOT contain `outside`
    delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    try {
      await expect(
        server.createOfflineFileSession({ fileId: "file-bn99-s1e1", localPath: evil }),
      ).rejects.toThrow(/offline_path_outside_root/);
    } finally {
      if (prevA === undefined) delete process.env.SF_BADGER_OFFLINE_DIR;
      else process.env.SF_BADGER_OFFLINE_DIR = prevA;
      if (prevB === undefined) delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
      else process.env.SPACEFLEET_RUNTIME_DATA_DIR = prevB;
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
      process.env.SF_BADGER_OFFLINE_DIR = tmpDir; // does NOT contain the paths below
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

    it("accepts a download under the runtime's default data dir", async () => {
      if (skipIfSandboxed()) return;
      const offlineDefault = join(getDesktopPlatform().paths.runtimeDataDir(process.env), "offline", "default");
      expect(offlineDefault.startsWith(xdg)).toBe(true);
      mkdirSync(offlineDefault, { recursive: true });
      const mkv = join(offlineDefault, "Brooklyn Nine-Nine - S01E01 - Pilot.mkv");
      writeFileSync(mkv, PAYLOAD);
      console.info("[playback-server-offline:default-root] serving", { mkv });
      const created = await server.createOfflineFileSession({ fileId: "file-bn99-s1e1", localPath: mkv });
      expect((await fetch(created.url)).status).toBe(200);
    });

    it("rejects a path under the legacy shared /tmp/spacefleet-runtime", async () => {
      if (skipIfSandboxed()) return;
      // Containment is checked before the file is opened, so nothing needs to exist under /tmp.
      await expect(
        server.createOfflineFileSession({ fileId: "file-bn99-s1e1", localPath: "/tmp/spacefleet-runtime/offline/default/x.mkv" }),
      ).rejects.toThrow(/offline_path_outside_root/);
    });
  });
});
