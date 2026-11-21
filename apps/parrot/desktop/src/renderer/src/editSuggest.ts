/**
 * The edit dialog's connected autocomplete on the desktop (PAR-META-18): the library's suggestions are ranked here
 * from the window's library snapshot, at once; the metadata service's come through the main process (`suggestEdit`),
 * and an album pick's cover too (`suggestEditCover`). The metadata service is asked only while the user types in the
 * dialog (PAR-COPY-01).
 */
import { useMemo } from "react";
import { parrotLibrarySuggestions, type ParrotSuggestLibrary } from "@space/parrot-core";
import type { ParrotEditSuggest, ParrotEditSuggestLabels } from "@space/ui/parrot/manage";
import type { ParrotLibrary } from "../../shared/ipc";
import type { Translate } from "./i18n";

export const editSuggestLabels = (t: Translate): ParrotEditSuggestLabels => ({
  fits: t("manage.suggestFits"),
  fitsAlbum: t("manage.suggestFitsAlbum"),
  only: (text) => t("manage.suggestOnly", { text }),
  inLibrary: t("manage.suggestInLibrary"),
  stillAsking: t("manage.suggestStillAsking"),
  trackOn: (title, number) => t("manage.suggestTrackOn", { title, number }),
  filledFrom: (name) => t("manage.suggestFilledFrom", { name }),
  undo: t("manage.suggestUndo"),
  restore: (value) => t("manage.suggestRestore", { value }),
  dots: (fields) => t("manage.suggestDots", { fields }),
  failed: (reason) => t("manage.fetchFailed", { reason }),
});

/** The library snapshot in the ranking's terms (built once per snapshot: the ranking indexes it once too). */
export const parrotSuggestLibrary = (library: Pick<ParrotLibrary, "artists" | "albums" | "tracks">): ParrotSuggestLibrary => {
  const albums = new Map(library.albums.map((album) => [album.id, album]));
  return {
    artists: library.artists.map((artist) => ({ id: artist.id, name: artist.name })),
    albums: library.albums.map((album) => ({ id: album.id, title: album.title, artist: album.artistName, year: album.year, kind: null, musicId: null })),
    tracks: library.tracks.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artistName,
      albumId: track.albumId,
      album: track.albumTitle,
      number: track.number,
      disc: track.disc,
      year: albums.get(track.albumId)?.year ?? null,
    })),
  };
};

export function useEditSuggest(library: Pick<ParrotLibrary, "artists" | "albums" | "tracks">): ParrotEditSuggest {
  const ranked = useMemo(() => parrotSuggestLibrary(library), [library.artists, library.albums, library.tracks]);
  const covers = useMemo(() => new Map(library.albums.map((album) => [album.id, album.coverThumbUrl ?? album.coverUrl])), [library.albums]);
  return useMemo<ParrotEditSuggest>(
    () => ({
      library: (query) => parrotLibrarySuggestions(ranked, query),
      lookup: async (query) => {
        const answer = await window.parrot.suggestEdit(query);
        if (!answer.ok) throw new Error(answer.error);
        return answer.results;
      },
      cover: (coverId) => window.parrot.suggestEditCover(coverId),
      coverUrl: (s) => (s.inLibrary && s.kind !== "artist" && s.album?.id ? (covers.get(s.album.id) ?? null) : null),
    }),
    [ranked, covers],
  );
}
