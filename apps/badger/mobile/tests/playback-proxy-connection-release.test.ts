/**
 * @test-id MOBILE-PLAYBACK-PROXY-CONN-RELEASE-001
 * @level integration
 * @bugfix @regression-proof
 * @req PERF-PLAY-03
 *
 * Why exists: on the Apple TV (AppleTV6,2) playback grew the app by megabytes per second until jetsam killed it and
 * the TV froze. The iOS/tvOS loopback proxy (`PlaybackHttpServer`) only cancelled a connection from its last send
 * completion. When the player resets a connection mid-body (seek, track or quality switch), the connection goes to
 * `.failed` and that completion never fires, so Network.framework kept the failed connection, its queued 1 MiB send
 * pieces and the closure holding the whole decrypted segment, for good. `malloc_history` on the simulator showed the
 * queued sends as ~1.16 MB `CProtocol.COptions.allocatedHandle` blocks. Badger iPhone, Badger tvOS and Parrot iOS
 * share this proxy (MediaProxy pod). The fix cancels a connection as soon as it fails. On macOS this compiles the real
 * proxy sources with a driver (fixtures/proxy-connection-release) that resets every other request mid-body and
 * counts how many segment payloads are still alive once every client is gone.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const PROXY = resolve(__dirname, "../../../../packages/mobile-media-proxy/ios/Proxy");
const DRIVER = resolve(__dirname, "fixtures/proxy-connection-release/main.swift");
// CastServer and PlaybackBridge need the React Native bridge and the cast stack; the HTTP server does not.
const PROXY_SOURCES = readdirSync(PROXY)
  .filter((f) => f.endsWith(".swift") && f !== "CastServer.swift" && f !== "PlaybackBridge.swift")
  .map((f) => join(PROXY, f));

function hasSwiftc(): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;
}

describe("iOS playback proxy releases connections the player resets", () => {
  it("accept() cancels a connection as soon as it fails", () => {
    const src = readFileSync(join(PROXY, "PlaybackHttpServer.swift"), "utf8");
    const start = src.indexOf("private func accept(_ conn: NWConnection)");
    expect(start, "accept(_:) not found").toBeGreaterThan(-1);
    const accept = src.slice(start, src.indexOf("\n  }\n", start));
    expect(accept).toMatch(
      /conn\.stateUpdateHandler = \{ \[weak conn\] state in\s+if case \.failed = state \{ conn\?\.cancel\(\) \}/,
    );
    // The handler must be in place before the connection starts, or an early reset is missed.
    expect(accept.indexOf("stateUpdateHandler")).toBeLessThan(accept.indexOf("conn.start("));
  });

  const work = mkdtempSync(join(tmpdir(), "proxy-conn-release-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it.skipIf(!hasSwiftc())(
    "no segment stays alive after clients reset mid-body (real proxy, real sockets)",
    () => {
      const bin = join(work, "driver");
      execFileSync("xcrun", ["swiftc", "-O", ...PROXY_SOURCES, DRIVER, "-o", bin], { stdio: "inherit" });
      // A reset leaks only when it lands while a piece is still queued in Network.framework (a few percent of resets on
      // macOS), so 200 resets: the unfixed proxy kept 5 to 11 segments alive in every run, the fixed one none.
      const out = execFileSync(bin, ["400"], { encoding: "utf8" }).trim();
      console.info(`[proxy-conn-release] ${out}`);
      const result = JSON.parse(out.split("\n").pop() ?? "{}") as {
        segments: number;
        fullBytes: number;
        livePayloads: number;
      };
      expect(result.segments).toBe(400);
      // The clients that read to the end got 200 whole 4 MiB segments (plus headers): serving still works.
      expect(result.fullBytes).toBeGreaterThanOrEqual(200 * 4 * 1024 * 1024);
      expect(result.livePayloads).toBe(0);
    },
    300_000,
  );
});
