/**
 * @test-id PARROT-DESKTOP-COVER-SERVER-001
 * @level unit
 * @why PAR-META-04: the window shows an album's cover (the picture built into the music files) from main's loopback
 *   server, behind the same random path secret as the songs. The real server runs on 127.0.0.1; only the cover and
 *   chunk loaders are replaced.
 * @covers apps/parrot/desktop/src/main/playbackServer.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { startParrotPlaybackServer, type ParrotPlaybackServer } from "../src/main/playbackServer";

const log = (message: string, data?: unknown) => console.log(`[PARROT-DESKTOP-COVER-SERVER-001] ${message}`, data === undefined ? "" : JSON.stringify(data));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe("parrot playback server covers", () => {
  let server: ParrotPlaybackServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("serves an opened cover under the secret path, and 404 for an unknown one or a guessed path", async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    server = await startParrotPlaybackServer({
      findFile: () => null,
      load: async () => {
        throw new Error("no chunk in this test");
      },
      loadForReading: async () => {
        throw new Error("no chunk in this test");
      },
      loadCover: async (objectKey) => {
        asked.push(objectKey);
        return objectKey === "assets/one" ? { bytes: JPEG, mime: "image/jpeg" } : null;
      },
      log: (line) => lines.push(line),
    });
    const url = server.coverUrlFor("assets/one");
    log("cover url", url);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/cover\/assets%2Fone$/);

    const found = await fetch(url);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("image/jpeg");
    expect(found.headers.get("cache-control")).toContain("private");
    // The window fetches the bytes into a blob: picture for the system media panel (PLAY-OSMEDIA-01).
    expect(found.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(JPEG);

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(JPEG.length));

    expect((await fetch(server.coverUrlFor("assets/missing"))).status).toBe(404);
    const guessed = url.replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`);
    expect((await fetch(guessed)).status).toBe(404);
    log("asked", asked);
    log("server log", lines);
    expect(asked).toEqual(["assets/one", "assets/one", "assets/missing"]);
  });
});
