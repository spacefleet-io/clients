import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ParrotAlbumTile, ParrotArtistPageCover, ParrotArtistTile, ParrotChips, ParrotSongList, ParrotTileGrid } from "../src/parrot/library";
import { ParrotArtistCircle } from "../src/parrot/screens";

// The library pieces the desktop renderer and the web player share (PAR-LOOK-01, REL-FAM-02).
// @req PAR-LOOK-01
describe("[parrot] library pieces", () => {
  it("an album tile shows art, title and artist · year; the playing one is ringed with the equaliser", () => {
    const album = { id: "a1", title: "Low Orbit", artistName: "", year: 2021 };
    const idle = renderToStaticMarkup(<ParrotAlbumTile album={album} unknownArtist="Unknown artist" onOpen={() => undefined} />);
    const playing = renderToStaticMarkup(<ParrotAlbumTile album={album} src="cover://a1" unknownArtist="Unknown artist" playing onOpen={() => undefined} testId="library-album" />);
    console.info("[parrot-library] idle tile", idle.slice(0, 160));
    expect(idle).toContain('data-testid="album-tile"');
    expect(idle).toContain("Unknown artist · 2021");
    expect(idle).not.toContain("parrot-eq");
    expect(playing).toContain('data-testid="library-album"');
    expect(playing).toContain('data-playing="true"');
    expect(playing).toContain("outline-primary");
    expect(playing).toContain("parrot-eq");
    expect(playing).toContain('src="cover://a1"');
  });

  it("the grid fits 10.5rem album tiles (7 a row at 1440px) and 9.5rem artist tiles", () => {
    expect(renderToStaticMarkup(<ParrotTileGrid>{null}</ParrotTileGrid>)).toContain("minmax(10.5rem,1fr)");
    expect(renderToStaticMarkup(<ParrotTileGrid kind="artist">{null}</ParrotTileGrid>)).toContain("minmax(9.5rem,1fr)");
    expect(renderToStaticMarkup(<ParrotArtistTile id="r1" name="Juniper Skies" detail="2 albums" onOpen={() => undefined} />)).toContain("rounded-full");
  });

  // @req PAR-META-15
  it("an artist with a photo shows it on its tile, its Home circle and its page, with the credit line under the page's photo", () => {
    const tile = renderToStaticMarkup(<ParrotArtistTile id="r1" src="cover://r1-thumb" name="Juniper Skies" detail="2 albums" onOpen={() => undefined} />);
    const circle = renderToStaticMarkup(<ParrotArtistCircle id="r1" src="cover://r1-thumb" name="Juniper Skies" onOpen={() => undefined} />);
    const drawn = renderToStaticMarkup(<ParrotArtistTile id="r1" name="Juniper Skies" detail="2 albums" onOpen={() => undefined} />);
    expect(tile).toContain('src="cover://r1-thumb"');
    expect(circle).toContain('src="cover://r1-thumb"');
    expect(drawn).toContain('data-cover="drawn"');
    expect(drawn).not.toContain("<img");

    const credit = { author: "Jane Doe", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0" };
    const linked = renderToStaticMarkup(
      <ParrotArtistPageCover id="r1" src="cover://r1" credit={credit} creditLabel={(author, licence) => `Photo : ${author}, ${licence}`} />
    );
    console.info("[parrot-library] artist page photo", linked);
    expect(linked).toContain('src="cover://r1"');
    expect(linked).toContain('data-testid="artist-photo-credit"');
    expect(linked).toContain("Photo : Jane Doe, ");
    expect(linked).toContain('<a href="https://creativecommons.org/licenses/by-sa/4.0" target="_blank" rel="noreferrer"');
    expect(linked).toMatch(/>CC BY-SA 4\.0<\/a><\/figcaption>/);

    const plain = renderToStaticMarkup(<ParrotArtistPageCover id="r1" src="cover://r1" credit={{ ...credit, licence: "Public domain", licenceUrl: null }} />);
    expect(plain).toContain("Photo: Jane Doe, Public domain");
    expect(plain).not.toContain("<a ");

    const uncredited = renderToStaticMarkup(<ParrotArtistPageCover id="r1" src="cover://r1" credit={null} />);
    const noPhoto = renderToStaticMarkup(<ParrotArtistPageCover id="r1" credit={credit} />);
    expect(uncredited).not.toContain("artist-photo-credit");
    expect(noPhoto).not.toContain("artist-photo-credit");
  });

  it("the chips mark the picked one pressed and green", () => {
    const html = renderToStaticMarkup(
      <ParrotChips
        chips={[
          { value: "albums", label: "Albums", testId: "chip-albums" },
          { value: "songs", label: "Songs" },
        ]}
        value="albums"
        onChange={() => undefined}
      />
    );
    console.info("[parrot-library] chips", html);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="chip-albums"[^>]*bg-primary/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Songs</);
  });

  // The browser check of the same rule (headings over their columns, phone width, EN/FR) is
  // apps/parrot/desktop/e2e/web-player-covers.e2e.test.ts.
  it("the song list lays its columns once for the heading and every row; a narrow list puts the artist under the title", () => {
    const labels = { song: "Song", artist: "Artist", album: "Album", time: "Time", unknownArtist: "Unknown artist", play: (title: string) => `Play ${title}` };
    const tracks = [{ id: "t1", title: "Opening Lights", artistName: "Test Tones", albumTitle: "Low Orbit", durationMs: 20_000 }];
    const html = renderToStaticMarkup(<ParrotSongList tracks={tracks} playingId={undefined} playing={false} showAlbum labels={labels} onPlay={() => undefined} actions={() => <button type="button">+</button>} />);
    console.info("[parrot-library] song list", html.slice(0, 600));
    // One grid on the list; the heading, the list and each row are subgrids spanning it.
    expect(html).toContain("@container");
    expect(html).toContain("grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_4rem_auto]");
    // A narrow list puts the row's buttons on their own line under the title; a wide one in the last column.
    expect(html).toContain('class="col-span-2 col-start-2 flex items-center @lg:col-span-1 @lg:col-start-auto" data-testid="song-row-actions"');
    expect(html.match(/col-span-full grid[^"]*grid-cols-subgrid/g)).toHaveLength(3);
    expect(html).not.toContain("grid-template-columns");
    // Artist and album headings and cells only from 32rem; under the title below that.
    expect(html).toMatch(/<span class="hidden @lg:block">Artist<\/span><span class="hidden @lg:block">Album<\/span>/);
    // The artist and album names sit in their own element, which becomes a link to their page when the app gives one.
    expect(html).toMatch(/class="truncate font-medium" title="Opening Lights">Opening Lights<\/span><\/span><span class="block truncate text-xs text-muted-foreground @lg:hidden" title="Test Tones" data-testid="song-artist-under-title"><span>Test Tones<\/span></);
    expect(html).toMatch(/class="hidden truncate text-muted-foreground @lg:block" title="Low Orbit"><span>Low Orbit<\/span></);
    // Without buttons or the album column, the narrow and wide grids drop those columns.
    const plain = renderToStaticMarkup(<ParrotSongList tracks={tracks} playingId={undefined} playing={false} showAlbum={false} labels={labels} onPlay={() => undefined} />);
    expect(plain).toContain("grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_4rem]");
    expect(plain).not.toContain(">Album<");
  });
});
