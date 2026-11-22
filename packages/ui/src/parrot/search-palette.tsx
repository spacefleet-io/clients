import * as React from "react";
import { ListEnd } from "lucide-react";
import { searchPaletteStrings } from "@space/shared/searchPaletteStrings";

import { SearchPalette, type SearchPaletteItem } from "../search-palette";

/**
 * Parrot's search palette (UX-SEARCH-01), shared by the desktop app and the web player: the library's artists,
 * albums, songs and playlists, an album or song also found by its artist; Enter opens the artist, the album or the
 * playlist, and a song opens its album (Parrot has no page for one song). The artist's and album's names under a result open their own
 * pages (PAR-NAV-05). A song result also has Add to queue (PAR-CARD-02).
 */

export type ParrotSearchArtist = { id: string; name: string };
export type ParrotSearchAlbum = { id: string; title: string; artistName: string; artistId?: string | null };
export type ParrotSearchSong = { id: string; title: string; artistName: string; artistId?: string | null; albumId: string; albumTitle: string };
/** A playlist under the name the user sees (Liked songs in the app's language). */
export type ParrotSearchPlaylist = { id: string; name: string };

export type ParrotSearchPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artists: readonly ParrotSearchArtist[];
  albums: readonly ParrotSearchAlbum[];
  /** Read only while the palette is open (the web player gathers them album by album). */
  songs: () => readonly ParrotSearchSong[];
  playlists: readonly ParrotSearchPlaylist[];
  /** The app's UI language code. */
  language: string | undefined;
  onOpenArtist: (id: string) => void;
  onOpenAlbum: (id: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Draws an album's cover. */
  renderCover?: (albumId: string) => React.ReactNode;
  /** A song result's Add to queue button, under the card's label (PAR-CARD-02). */
  addToQueue?: { label: string; onAdd: (song: ParrotSearchSong) => void };
};

export function ParrotSearchPalette({ open, onOpenChange, artists, albums, songs, playlists, language, onOpenArtist, onOpenAlbum, onOpenPlaylist, renderCover, addToQueue }: ParrotSearchPaletteProps) {
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
        actions: addToQueue
          ? [{ label: addToQueue.label, icon: <ListEnd aria-hidden className="h-4 w-4" />, onSelect: () => addToQueue.onAdd(s), testId: "search-palette-add-to-queue" }]
          : undefined,
      })),
      ...playlists.map((p) => ({ key: `playlist:${p.id}`, kind: "playlist", title: p.name })),
    ];
  }, [open, artists, albums, songs, playlists, onOpenArtist, onOpenAlbum, addToQueue]);
  return (
    <SearchPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      labels={labels}
      onSelect={(item) => {
        const [kind, id] = [item.kind, item.key.slice(item.key.indexOf(":") + 1)];
        if (kind === "artist") onOpenArtist(id);
        else if (kind === "playlist") onOpenPlaylist(id);
        else onOpenAlbum(kind === "album" ? id : item.image!);
      }}
      renderImage={renderCover ? (item) => renderCover(item.image!) : undefined}
    />
  );
}
