// What the artist page (PAR-LOOK-06) reads and does: the artist's albums (newest last, as `listArtistAlbums` orders
// them), every song on them, the photo with its shimmer (PAR-META-15, PAR-META-20), Play / Shuffle / Play next over all
// the songs, Save offline (each album kept, since the kept list has no artist kind, PAR-OFFL-01) and the "…" sheet
// with Edit details (PAR-META-31) and Delete last (PAR-LIB-03).
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ArrowDownToLine, CircleCheck, ListEnd, ListPlus, ListStart, Pencil, Trash2 } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { parrotCardActionList, type OfflineReach, type ParrotCardActionId, type ParrotCardPlayer, type SongRow } from "@space/parrot-core";
import type { ParrotPhotoCredit } from "@space/parrot-library-db-definition/ops";
import { artistPicturesWaiting } from "../../lib/picturesWaiting";
import { listArtistAlbums, listSongs, readArtistName, readArtistPicture, type AlbumWithCover, type WithCoverKeys } from "../../lib/library";
import type { NowPlaying } from "../../lib/nowPlaying";
import { useQuery } from "../../state/useQuery";
import { useManage } from "../../state/manage";
import { usePlay } from "../../state/usePlay";
import { useNowPlaying } from "../../state/usePlayerState";
import { usePlaylistEditor, type SheetAction } from "../../state/playlistEditor";
import { useSession } from "../../state/session";
import { useKept, useOfflineReach } from "../kept";
import type { RootStack } from "../routes";

const SHEET_ICONS: Partial<Record<ParrotCardActionId, SheetAction["icon"]>> = {
  "play-next": ListStart,
  "add-to-queue": ListEnd,
  "add-to-playlist": ListPlus,
};

/** "3 h 12 min", "42 min": an artist's whole running time. */
export const totalDuration = (ms: number, t: (key: string, options?: Record<string, unknown>) => string) => {
  const minutes = Math.round(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? t("parrot.artist.hoursMinutes", { hours, minutes: minutes % 60 }) : t("parrot.artist.minutes", { minutes });
};

export type ArtistSong = WithCoverKeys<SongRow>;
export type ArtistAlbum = AlbumWithCover;

/** Everything the artist page lays out. */
export type ArtistPage = {
  t: (key: string, options?: Record<string, unknown>) => string;
  /** The name the library has now: a rename saved on another device shows while the page is open (PAR-SYNC-01). */
  name: string;
  albums: ArtistAlbum[];
  songs: ArtistSong[];
  /** "N albums · N songs · 3 h 12 min". */
  counts: string;
  loading: boolean;
  error: string | null;
  photo: { pictureObjectKey: string; pictureThumbObjectKey: string | null; credit: ParrotPhotoCredit | null } | null;
  /** No photo yet but one may still come: a shimmer, never "no photo" (PAR-META-20). */
  photoWaiting: boolean;
  now: NowPlaying | null;
  starting: string | null;
  reach: OfflineReach | null;
  allKept: boolean;
  toggleKeep: () => void;
  openMenu: () => void;
  playAll: () => void;
  shuffleAll: () => void;
  playNextAll: () => void;
  playFrom: (list: ArtistSong[], index: number) => void;
  openAlbum: (album: ArtistAlbum) => void;
  openSong: (song: ArtistSong) => void;
};

export const useArtistPage = (artistId: string, openedName: string): ArtistPage => {
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const albumsQuery = useQuery(() => listArtistAlbums(artistId), [artistId, version]);
  const songsQuery = useQuery(() => listSongs(), [version]);
  const picture = useQuery(() => readArtistPicture(artistId), [artistId, version]);
  const storedName = useQuery(() => readArtistName(artistId), [artistId, version]);
  const name = storedName.data ?? openedName;
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const manage = useManage();
  const editor = usePlaylistEditor();
  const kept = useKept();
  const reach = useOfflineReach();
  const now = useNowPlaying();
  const { play, queue, starting, error } = usePlay();

  const albums = albumsQuery.data ?? [];
  // Every song on the artist's albums, album by album in the albums' order, then by disc and number.
  const songs = useMemo(() => {
    const order = new Map(albums.map((album, index) => [album.id, index]));
    return (songsQuery.data ?? [])
      .filter((song) => order.has(song.albumId))
      .sort((a, b) => order.get(a.albumId)! - order.get(b.albumId)! || a.disc - b.disc || (a.number ?? 0) - (b.number ?? 0));
  }, [albums, songsQuery.data]);
  const durationMs = songs.reduce((sum, song) => sum + (song.durationMs ?? 0), 0);

  const photo = picture.data ?? null;
  const pictureRead = useRef<string | null>(null);
  if (!picture.loading) pictureRead.current = artistId;
  const pictureFirstRead = picture.loading && pictureRead.current !== artistId;
  const [passWaiting, setPassWaiting] = useState(artistPicturesWaiting.has(artistId));
  useEffect(() => {
    setPassWaiting(artistPicturesWaiting.has(artistId));
    return artistPicturesWaiting.onChange(() => setPassWaiting(artistPicturesWaiting.has(artistId)));
  }, [artistId]);

  const info = { title: name };
  const player: ParrotCardPlayer<ArtistSong> = {
    play: (list) => void play(list, 0, info),
    shuffle: (list) => void play(list, Math.floor(Math.random() * list.length), info, { shuffle: true }),
    playNext: (list) => void queue(list, "next", info).then(editor.queued),
    addToQueue: (list) => void queue(list, "end", info).then(editor.queued),
  };
  const allKept = albums.length > 0 && albums.every((album) => kept.entry("album", album.id));
  const toggleKeep = () => {
    for (const album of albums) if (allKept || !kept.entry("album", album.id)) editor.toggleKeep("album", album.id);
  };
  const openMenu = () => {
    const shared = parrotCardActionList((key) => t(`shell.${key}`), () => songs, player, {
      onAddToPlaylist: (list) => editor.addToPlaylist({ id: artistId, title: name, trackIds: list.map((song) => song.id) }),
    }).filter((action) => SHEET_ICONS[action.id]);
    editor.openActions(
      name,
      [
        ...shared.map((action) => ({ id: action.id, label: action.label, icon: SHEET_ICONS[action.id]!, onSelect: action.onSelect, testID: `artist-menu-${action.id}` })),
        {
          id: "keep",
          label: allKept ? t("parrot.kept.remove") : t("parrot.kept.keep"),
          icon: allKept ? CircleCheck : ArrowDownToLine,
          onSelect: toggleKeep,
          testID: allKept ? "artist-menu-unkeep" : "artist-menu-keep",
        },
        {
          id: "edit",
          label: t("shell.manage.edit"),
          icon: Pencil,
          onSelect: () => manage.editArtist(artistId),
          testID: "artist-menu-edit",
        },
        {
          id: "delete",
          label: t("shell.manage.delete"),
          icon: Trash2,
          destructive: true,
          onSelect: () => manage.remove({ kind: "artist", id: artistId }, name, () => navigation.goBack()),
          testID: "artist-menu-delete",
        },
      ],
      "artist-menu"
    );
  };
  // Each part keeps its own words together ("7 h 20 min" never splits), so the line only wraps between parts.
  const counts = [
    t("parrot.library.albums", { count: albums.length }),
    t("parrot.library.songs", { count: songs.length }),
    ...(durationMs > 0 ? [totalDuration(durationMs, t)] : []),
  ]
    .map((part) => part.replace(/ /g, "\u00a0"))
    .join(" · ");

  return {
    t,
    name,
    albums,
    songs,
    counts,
    loading: albumsQuery.loading,
    error: error ?? albumsQuery.error ?? null,
    photo,
    photoWaiting: !photo && (pictureFirstRead || passWaiting),
    now,
    starting,
    reach,
    allKept,
    toggleKeep,
    openMenu,
    playAll: () => songs.length > 0 && player.play(songs),
    shuffleAll: () => songs.length > 0 && player.shuffle(songs),
    playNextAll: () => songs.length > 0 && player.playNext(songs),
    playFrom: (list, index) => void play(list, index, info),
    openAlbum: (album) => navigation.navigate("Album", { albumId: album.id, title: album.title, artistName: album.artistName, cover: album }),
    openSong: (song) => editor.openSong({ id: song.id, title: song.title }, undefined, { onAddToQueue: () => queue([song], "end", info) }),
  };
};
