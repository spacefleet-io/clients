/**
 * @test-id PARROT-CORE-SEARCH-001
 * @level unit
 * @why The desktop, the phone and the web player search the library with this one helper (REL-FAM-02), so the
 *   same query finds the same albums, artists, songs and playlists everywhere. A slip hides rows the user typed or
 *   makes one app find what another misses.
 * @covers packages/parrot-core/src/search.ts
 */
import { describe, expect, it } from "bun:test";
import { filterParrotAlbums, filterParrotArtists, filterParrotPlaylists, filterParrotTracks, matchesSearch } from "../src/search";

describe("the Parrot library search", () => {
  // @req PAR-NAV-02
  it("matches every word in any of the names, in any order, ignoring case and accents", () => {
    expect(matchesSearch("", "anything")).toBe(true);
    expect(matchesSearch("   ", "anything")).toBe(true);
    expect(matchesSearch("beyonce halo", "Halo", "Beyoncé")).toBe(true);
    expect(matchesSearch("ÉTÉ", "L'été indien")).toBe(true);
    expect(matchesSearch("halo moon", "Halo", "Beyoncé")).toBe(false);
    expect(matchesSearch("nova", null, undefined, "Nova")).toBe(true);
  });

  // @req PAR-NAV-02
  it("filters each view on the names it shows", () => {
    const albums = [
      { id: "a1", title: "Low Orbit", artistName: "Nova" },
      { id: "a2", title: "Été", artistName: "Zoé" },
    ];
    const artists = [{ id: "r1", name: "Nova" }, { id: "r2", name: "Zoé" }];
    const tracks = [
      { id: "t1", title: "One", artistName: "Nova", albumTitle: "Low Orbit" },
      { id: "t2", title: "Deux", artistName: "Zoé", albumTitle: "Été" },
    ];
    expect(filterParrotAlbums(albums, "orbit nova").map((row) => row.id)).toEqual(["a1"]);
    expect(filterParrotAlbums(albums, "")).toEqual(albums);
    expect(filterParrotArtists(artists, "zoe").map((row) => row.id)).toEqual(["r2"]);
    expect(filterParrotTracks(tracks, "ete deux").map((row) => row.id)).toEqual(["t2"]);
    expect(filterParrotTracks(tracks, "low one").map((row) => row.id)).toEqual(["t1"]);
    const playlists = [{ id: "liked", name: "" }, { id: "p1", name: "Road trip" }];
    const nameOf = (playlist: { id: string; name: string }) => (playlist.id === "liked" ? "Titres likés" : playlist.name);
    expect(filterParrotPlaylists(playlists, "likes", nameOf).map((row) => row.id)).toEqual(["liked"]);
    expect(filterParrotPlaylists(playlists, "road", nameOf).map((row) => row.id)).toEqual(["p1"]);
  });
});
