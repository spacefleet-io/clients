import { afterEach, describe, expect, it, mock } from "bun:test";
import { downloadStorageObjectViaTunnel, watchLibraryTunnelWarnings } from "../src/api";

const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) => Promise.reject(new TypeError("fetch failed")));
globalThis.fetch = fetchMock as unknown as typeof fetch;

afterEach(() => {
  fetchMock.mockClear();
});

/**
 * @test-id LIBRARY-DB-RUNTIME-TUNNEL-WARNINGS-001
 * @req PAR-UP-12[parrot]
 * @why PAR-UP-12 (Chris 2026-11-26): two light copies took 10 s and 14 s to upload against a 1.5 s encode, and
 *   parrot-main.log could not say why: the tunnel's retries and fallbacks were debug lines only. An app's main log
 *   now hears them.
 */
describe("[LIBRARY-DB-RUNTIME-TUNNEL-WARNINGS-001] tunnel warnings reach the app", () => {
  it("a transfer that retries tells its watchers, and stops telling once unwatched", async () => {
    const heard: Array<[string, Record<string, unknown>]> = [];
    const stop = watchLibraryTunnelWarnings((event, payload) => heard.push([event, payload]));
    const download = () =>
      downloadStorageObjectViaTunnel("token", "library/chunks/abc", { clientType: "test", downloadId: "d1", purpose: "library" }, "parrot").catch(
        () => undefined
      );
    await download();
    expect(heard.map(([event]) => event)).toContain("tunnel.session_open.retry");
    expect(heard.every(([event]) => !event.startsWith("tunnel.resolve_gateway.media") && event !== "tunnel.traffic.changed")).toBe(true);
    stop();
    const before = heard.length;
    await download();
    expect(heard.length).toBe(before);
  }, 20_000);
});
