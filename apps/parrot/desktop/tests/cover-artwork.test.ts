/**
 * @test-id PARROT-DESKTOP-COVER-ARTWORK-001
 * @level integration (real loopback cover server and real fetch; only the blob: URL maker is counted)
 * @why PLAY-OSMEDIA-01 item 2: the system media panel shows the album's large cover, handed over as a blob: picture
 *   the window holds (never the loopback address). Only one picture is held: the previous song's is released.
 * @covers apps/parrot/desktop/src/renderer/src/coverArtwork.ts, apps/parrot/desktop/src/main/playbackServer.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { createParrotChunkReads } from "@space/parrot-core";
import { planMediaSession } from "@space/media-session";
import { createCoverArtwork } from "../src/renderer/src/coverArtwork";
import { startParrotPlaybackServer, type ParrotPlaybackServer } from "../src/main/playbackServer";

const log = (message: string, data?: unknown) => console.log(`[PARROT-DESKTOP-COVER-ARTWORK-001] ${message}`, data === undefined ? "" : JSON.stringify(data));
const LARGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const OTHER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);

describe("parrot desktop media panel artwork", () => {
  let server: ParrotPlaybackServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  // @req PLAY-OSMEDIA-01
  it("reads the large cover into one held blob: URL and releases the previous song's", async () => {
    server = await startParrotPlaybackServer({
      findFile: () => null,
      load: async () => {
        throw new Error("no chunk in this test");
      },
      loadForReading: async () => {
        throw new Error("no chunk in this test");
      },
      loadCover: async (key) => (key === "assets/large" ? { bytes: LARGE, mime: "image/jpeg" } : key === "assets/other" ? { bytes: OTHER, mime: "image/png" } : null),
      reads: createParrotChunkReads(),
      log: () => undefined,
    });
    const made: Blob[] = [];
    const revoked: string[] = [];
    const fetched: string[] = [];
    const artwork = createCoverArtwork({
      fetch: (url) => {
        fetched.push(url);
        return fetch(url);
      },
      createObjectURL: (blob) => {
        made.push(blob);
        return `blob:parrot/${made.length}`;
      },
      revokeObjectURL: (url) => revoked.push(url),
    });

    const first = await artwork(server.coverUrlFor("assets/large"));
    log("first", { first, type: made[0]?.type, size: made[0]?.size });
    expect(first).toBe("blob:parrot/1");
    expect(made[0].type).toBe("image/jpeg");
    expect(new Uint8Array(await made[0].arrayBuffer())).toEqual(LARGE);
    // The same song again reuses the held picture.
    expect(await artwork(server.coverUrlFor("assets/large"))).toBe("blob:parrot/1");
    expect(fetched).toHaveLength(1);

    const second = await artwork(server.coverUrlFor("assets/other"));
    await Promise.resolve();
    log("second", { second, revoked });
    expect(second).toBe("blob:parrot/2");
    expect(revoked).toEqual(["blob:parrot/1"]);

    // A missing cover gives no picture (the panel shows none), and releases the held one.
    expect(await artwork(server.coverUrlFor("assets/missing"))).toBeNull();
    await Promise.resolve();
    expect(revoked).toEqual(["blob:parrot/1", "blob:parrot/2"]);

    // The media session keeps a blob: picture and would drop the loopback address.
    const plan = (artworkUrl: string) =>
      planMediaSession({ status: "playing", info: { title: "Gale", artist: "Test Band", album: "Second Wind", artworkUrl }, positionS: 0, rate: 1, canNext: false, canPrevious: false, canSeek: true });
    const kept = plan("blob:parrot/2");
    const dropped = plan(server.coverUrlFor("assets/large"));
    log("plans", { kept: kept.metadata?.artwork, dropped: dropped.metadata?.artwork });
    expect(kept.metadata?.artwork).toEqual([{ src: "blob:parrot/2" }]);
    expect(dropped.metadata?.artwork).toEqual([]);
  });
});
