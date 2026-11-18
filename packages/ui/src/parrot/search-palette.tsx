import * as React from "react";
import { searchPaletteStrings } from "@space/shared/searchPaletteStrings";

import { SearchPalette, type SearchPaletteItem } from "../search-palette";

/**
 * Parrot's search palette (UX-SEARCH-01), shared by the desktop app and the web player: the library's artists,
 * albums and songs, an album or song also found by its artist; Enter opens the artist or the album, and a song
 * opens its album (Parrot has no page for one song). The artist's and album's names under a result open their own
 * pages (PAR-NAV-05).
 */

export type ParrotSearchArtist = { id: string; name: string };
export type ParrotSearchAlbum = { id: string; title: string; artistName: string; artistId?: string | null };
export type ParrotSearchSong = { id: string; title: string; artistName: string; artistId?: string | null; albumId: string; albumTitle: string };

export type ParrotSearchPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artists: readonly ParrotSearchArtist[];
  albums: readonly ParrotSearchAlbum[];
  /** Read only while the palette is open (the web player gathers them album by album). */
  songs: () => readonly ParrotSearchSong[];
  /** The app's UI language code. */
  language: string | undefined;
  onOpenArtist: (id: string) => void;
  onOpenAlbum: (id: string) => void;
  /** Draws an album's cover. */
  renderCover?: (albumId: string) => React.ReactNode;
};

export function ParrotSearchPalette({ open, onOpenChange, artists, albums, songs, language, onOpenArtist, onOpenAlbum, renderCover }: ParrotSearchPaletteProps) {
  const labels = React.useMemo(() => searchPaletteStrings("parrot", language), [language]);
  const items = React.useMemo<SearchPaletteItem[]>(() => {
    if (!open) return [];
    const artistLink = (name: string, id: string | null | undefined) => (name ? [{ text: name, onOpen: id ? () => onOpenArtist(id) : undefined }] : []);
    return [
      ...artists.map((a) => ({ key: `artist:${a.id}`, kind: "artist", title: a.name })),
      ...albums.map((a) => ({
        key: `album:${a.id}`,
        kind: "album",
        title: a.title,
        subtitle: a.artistName,
        subtitleLinks: a.artistId && a.artistName ? artistLink(a.artistName, a.artistId) : undefined,
        image: a.id,
        keywords: [a.artistName],
      })),
      ...songs().map((s) => ({
        key: `song:${s.id}`,
        kind: "song",
        title: s.title,
        subtitle: `${s.artistName} · ${s.albumTitle}`,
        subtitleLinks: [...artistLink(s.artistName, s.artistId), { text: s.albumTitle, onOpen: () => onOpenAlbum(s.albumId) }],
        image: s.albumId,
        keywords: [s.artistName, s.albumTitle],
      })),
    ];
  }, [open, artists, albums, songs, onOpenArtist, onOpenAlbum]);
  return (
    <SearchPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      labels={labels}
      onSelect={(item) => {
        const [kind, id] = [item.kind, item.key.slice(item.key.indexOf(":") + 1)];
        if (kind === "artist") onOpenArtist(id);
        else onOpenAlbum(kind === "album" ? id : item.image!);
      }}
      renderImage={renderCover ? (item) => renderCover(item.image!) : undefined}
    />
  );
}
