/**
 * @test-id PARROT-MOBILE-TUNNEL-PLAYER-READ-IOS-001
 * @level integration
 * @req PAR-PLAY-12[parrot]
 * @bugfix @regression-proof
 * @why Chris 2026-11-27 (Parrot Android 0.1.63, "Armored Frame" by NULLREDUX_EXE): the song stayed at 0:00 with
 *   "Playback error: ERROR_CODE_IO_BAD_HTTP_STATUS" while every gateway download answered 200. The loopback proxy
 *   answers 502 when the player's own chunk read throws, and that read threw when a cancel aimed at loading ahead (a
 *   preload yielding, a rung switch) reached the download the player had joined, or when the gateway refused the
 *   download with a status a new session fixes. Parrot iOS shares the same proxy design (MediaProxy pod), and the
 *   unfixed Swift client failed 11 of these 22 expectations. On macOS this compiles the real `ios/Proxy` sources with a
 *   driver (fixtures/tunnel-player-read) against the fake gateway below; the Android twin is
 *   StorageTunnelClientPlayerReadTest.kt.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const PROXY = resolve(__dirname, "../../../../packages/mobile-media-proxy/ios/Proxy");
const DRIVER = resolve(__dirname, "fixtures/tunnel-player-read/main.swift");
// CastServer and PlaybackBridge need the React Native bridge; the tunnel client does not.
const PROXY_SOURCES = readdirSync(PROXY)
  .filter((f) => f.endsWith(".swift") && f !== "CastServer.swift" && f !== "PlaybackBridge.swift")
  .map((f) => join(PROXY, f));
const log = (step: string, detail: unknown) =>
  console.info(`[PARROT-MOBILE-TUNNEL-PLAYER-READ-IOS-001] ${step}`, JSON.stringify(detail));

function hasSwiftc(): boolean {
  // node:os, not `process.platform`: the app's declarations.d.ts types `process` as the babel-inlined env only.
  if (platform() !== "darwin") return false;
  return spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;
}

/**
 * The storage gateway's tunnel routes, plus /ctl/* for the driver: `reset` (optionally holding the first download, or
 * refusing every download on the first session with `status`/`code`), `arrived` (the held download reached us),
 * `release` (let it answer) and `downloads` (every `sid:key` asked for, in order).
 */
function fakeGateway() {
  let sessions = 0;
  let downloads: string[] = [];
  let hold = false;
  let refuse: { status: number; code: string } | null = null;
  let arrived = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  const send = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, { "Content-Length": Buffer.byteLength(body), Connection: "close" });
    res.end(body);
  };
  const readBody = async (req: IncomingMessage) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    return Buffer.concat(parts).toString("utf8");
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    switch (url.pathname) {
      case "/ctl/reset": {
        sessions = 0;
        downloads = [];
        hold = url.searchParams.get("hold") === "1";
        const status = url.searchParams.get("status");
        refuse = status ? { status: Number(status), code: url.searchParams.get("code") ?? "" } : null;
        arrived = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        log("reset", { hold, refuse });
        return send(res, 200, "ok");
      }
      case "/ctl/arrived":
        await arrived.promise;
        return send(res, 200, "1");
      case "/ctl/release":
        release.resolve();
        return send(res, 200, "ok");
      case "/ctl/downloads":
        return send(res, 200, JSON.stringify(downloads));
      case "/storage/tunnel/session":
        await readBody(req);
        sessions += 1;
        return send(res, 200, JSON.stringify({ sessionId: `sid-${sessions}` }));
      case "/storage/tunnel/frame":
        await readBody(req);
        return send(res, 200, JSON.stringify({ frame: { kind: "session.ack" } }));
      case "/storage/tunnel/download": {
        const { sessionId, objectKey } = JSON.parse(await readBody(req)) as { sessionId: string; objectKey: string };
        downloads.push(`${sessionId}:${objectKey}`);
        log("download", { sessionId, objectKey, n: downloads.length });
        if (refuse && sessionId === "sid-1") return send(res, refuse.status, JSON.stringify({ error: refuse.code }));
        if (downloads.length === 1 && hold) {
          arrived.resolve();
          await release.promise;
        }
        // Plain bytes: MediaCrypto.decryptSegment passes data without its magic header through.
        return send(res, 200, `plain-${objectKey}`);
      }
      default:
        return send(res, 404, "{}");
    }
  });
}

describe("iOS tunnel client: a player's chunk read survives loading ahead and session refusals", () => {
  const work = mkdtempSync(join(tmpdir(), "tunnel-player-read-"));
  const gateway = fakeGateway();
  afterAll(() => {
    gateway.close();
    rmSync(work, { recursive: true, force: true });
  });

  it.skipIf(!hasSwiftc())(
    "the real StorageTunnelClient.swift passes the driver's expectations",
    async () => {
      const bin = join(work, "driver");
      const build = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", ...PROXY_SOURCES, DRIVER, "-o", bin], {
        stdio: "inherit",
      });
      expect(build.status).toBe(0);
      await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
      const port = String((gateway.address() as AddressInfo).port);
      // The driver blocks on the gateway, so it runs as a child while this process keeps serving.
      const child = spawn(bin, [port], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      const exited = Promise.withResolvers<number | null>();
      child.on("close", exited.resolve);
      const code = await exited.promise;
      console.info(`[PARROT-MOBILE-TUNNEL-PLAYER-READ-IOS-001] driver\n${out}`);
      expect(out.split("\n").filter((line) => line.startsWith("FAIL"))).toEqual([]);
      expect(out).toContain("ALL PASS");
      expect(code).toBe(0);
    },
    300_000,
  );
});
