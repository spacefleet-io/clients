/**
 * @test-id SHARED-OFFLINE-MANAGE-001
 * @why OFFL-MANAGE-01: Settings › Manage offline content lists what is kept on the device with its size and the total at
 *   the top. Badger groups its saved files into films and shows › seasons › episodes; Parrot lists kept albums, playlists
 *   and songs kept on their own. A song or file two items hold counts once in the total.
 */
import { describe, expect, it } from "vitest";
import { groupBadgerOffline, groupParrotOffline, type BadgerOfflineTitle, type OfflineManageRow } from "../src/offlineManage";

const SUITE = "[SHARED-OFFLINE-MANAGE-001]";
const dump = (label: string, value: unknown) => console.log(`${SUITE} ${label}`, JSON.stringify(value, null, 2));
const outline = (rows: OfflineManageRow[], depth = 0): string[] =>
  rows.flatMap((row) => [`${"  ".repeat(depth)}${row.kind}:${row.title ?? "?"}:${row.bytes}`, ...outline(row.children, depth + 1)]);

const movie: BadgerOfflineTitle = { type: "movie", title: "Zodiac", posterPath: "/z.jpg", files: [{ id: "f-movie", season: null, episode: null }] };
const show: BadgerOfflineTitle = {
  type: "tv",
  title: "Andor",
  posterPath: "/a.jpg",
  files: [
    { id: "f-s1e1", season: 1, episode: 1 },
    { id: "f-s1e2", season: 1, episode: 2 },
    { id: "f-s2e1", season: 2, episode: 1 },
  ],
  seasons: [
    { seasonNumber: 1, name: "Season 1", posterPath: "/a1.jpg" },
    { seasonNumber: 2, name: "Season 2", posterPath: null },
  ],
  episodes: [
    { seasonNumber: 1, episodeNumber: 1, name: "Kassa" },
    { seasonNumber: 1, episodeNumber: 2, name: "That Would Be Me" },
    { seasonNumber: 2, episodeNumber: 1, name: "One Year Later" },
  ],
};
const titles: Record<string, BadgerOfflineTitle> = { "m-1": movie, "s-1": show };

describe(`${SUITE} groupBadgerOffline`, () => {
  it("groups films and shows › seasons › episodes, sums sizes, sorts by title then season and episode", () => {
    console.log(`${SUITE} phase=group`);
    const list = groupBadgerOffline(
      [
        { mediaId: "s-1", fileId: "f-s2e1", totalBytes: 300 },
        { mediaId: "m-1", fileId: "f-movie", totalBytes: 1000 },
        { mediaId: "s-1", fileId: "f-s1e2", totalBytes: 200 },
        { mediaId: "s-1", fileId: "f-s1e1", totalBytes: 100 },
      ],
      (id) => titles[id] ?? null
    );
    dump("outline", outline(list.rows));
    expect(outline(list.rows)).toEqual([
      "show:Andor:600",
      "  season:Season 1:300",
      "    episode:Kassa:100",
      "    episode:That Would Be Me:200",
      "  season:Season 2:300",
      "    episode:One Year Later:300",
      "movie:Zodiac:1000",
    ]);
    expect(list.totalBytes).toBe(1600);
    const season1 = list.rows[0].children[0];
    expect(season1).toMatchObject({ id: "s-1", seasonNumber: 1, imagePath: "/a1.jpg" });
    expect(season1.children[1]).toMatchObject({ kind: "episode", fileId: "f-s1e2", seasonNumber: 1, episodeNumber: 2 });
    // A season with no poster of its own shows the show's.
    expect(list.rows[0].children[1].imagePath).toBe("/a.jpg");
    expect(list.rows[1]).toMatchObject({ kind: "movie", id: "m-1", imagePath: "/z.jpg", fileId: "f-movie" });
  });

  it("counts one file once even when listed twice, and keeps a title the library no longer has", () => {
    console.log(`${SUITE} phase=dedupe+unknown`);
    const list = groupBadgerOffline(
      [
        { mediaId: "m-1", fileId: "f-movie", totalBytes: 1000 },
        { mediaId: "m-1", fileId: "f-movie", totalBytes: 1000 },
        { mediaId: "gone", fileId: "f-gone", totalBytes: 50 },
      ],
      (id) => titles[id] ?? null
    );
    dump("rows", list.rows);
    expect(list.totalBytes).toBe(1050);
    expect(outline(list.rows)).toEqual(["movie:Zodiac:1000", "movie:?:50"]);
  });

  it("puts a show's file whose episode is not in the library straight under the show", () => {
    console.log(`${SUITE} phase=loose-episode`);
    const list = groupBadgerOffline([{ mediaId: "s-1", fileId: "f-unknown", totalBytes: 70 }], (id) => titles[id] ?? null);
    dump("outline", outline(list.rows));
    expect(outline(list.rows)).toEqual(["show:Andor:70", "  episode:?:70"]);
  });

  it("is empty with nothing saved", () => {
    expect(groupBadgerOffline([], () => null)).toEqual({ rows: [], totalBytes: 0 });
  });
});

describe(`${SUITE} groupParrotOffline`, () => {
  const names: Record<string, { title: string; subtitle?: string | null; imagePath?: string | null }> = {
    "album:alb-1": { title: "Meteora", subtitle: "Linkin Park", imagePath: "cover://alb-1" },
    "album:alb-2": { title: "Hybrid Theory", subtitle: "Linkin Park" },
    "playlist:pl-1": { title: "Gym" },
    "song:t-9": { title: "Numb", subtitle: "Linkin Park" },
  };
  const bytes: Record<string, number> = { a: 100, b: 200, c: 400, d: 800 };

  it("lists albums, playlists, then songs kept on their own, each sorted by title, total counting shared songs once", () => {
    console.log(`${SUITE} phase=parrot`);
    const list = groupParrotOffline(
      [
        { kind: "song", id: "t-9", fileIds: ["d"] },
        { kind: "playlist", id: "pl-1", fileIds: ["a", "c", "c"] },
        { kind: "album", id: "alb-1", fileIds: ["a", "b"] },
        { kind: "album", id: "alb-2", fileIds: ["c"] },
      ],
      (fileId) => bytes[fileId] ?? 0,
      (kind, id) => names[`${kind}:${id}`] ?? null
    );
    dump("outline", outline(list.rows));
    expect(outline(list.rows)).toEqual(["album:Hybrid Theory:400", "album:Meteora:300", "playlist:Gym:500", "song:Numb:800"]);
    expect(list.totalBytes).toBe(1500);
    expect(list.rows[1]).toMatchObject({ id: "alb-1", subtitle: "Linkin Park", imagePath: "cover://alb-1", children: [] });
  });

  it("keeps an item the library no longer names, with no title", () => {
    const list = groupParrotOffline([{ kind: "album", id: "gone", fileIds: [] }], () => 0, () => null);
    dump("rows", list.rows);
    expect(list.rows).toMatchObject([{ kind: "album", id: "gone", title: null, bytes: 0 }]);
    expect(list.totalBytes).toBe(0);
  });
});
