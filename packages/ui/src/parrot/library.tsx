/**
 * Parrot's library pieces shared by the browser-engine apps (desktop renderer and web player), drawn from the approved
 * design (PAR-LOOK-01): the Albums / Artists / Songs chips, the album and artist tiles and the grid that holds them, the
 * back button, the album and artist page header and the song list. Texts come in already translated, so each app keeps
 * its own string table.
 */
import type { ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { formatDuration, type ParrotAlbumRow } from "@space/parrot-core";
import { BackButton } from "../button";
import { GuardedItems, RenderBoundary } from "../render-boundary";
import { UNAVAILABLE_CLASS } from "../unavailable";
import { cn } from "../utils";
import { ParrotCardOverlay, type ParrotCardControls } from "./card-actions";
import { ParrotCover, ParrotEqualizer, ParrotNameLink } from "./components";

/** The tile grid: about 10.5rem per tile, so a 1440px window shows 7 albums a row, as in the design. */
export function ParrotTileGrid({ kind = "album", children, testId }: { kind?: "album" | "artist"; children: ReactNode; testId?: string }) {
  return (
    <ul className={cn("grid gap-6", kind === "album" ? "grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]")} data-testid={testId}>
      {/* UX-CRASH-01: a tile that throws shows a placeholder in its cell; the other tiles stay. */}
      <GuardedItems name={testId ?? `${kind}-grid`} className="aspect-square">
        {children}
      </GuardedItems>
    </ul>
  );
}

/**
 * The album page's "Also by <artist>" row under the songs: the artist's other albums as tiles a little smaller than the
 * library's (8 a row at 1440px, as in the design). Nothing at all when the artist has no other album.
 */
export function ParrotAlsoBy<A extends { id: string }>({ title, albums, tile, testId = "album-also-by" }: { title: string; albums: readonly A[]; tile: (album: A) => ReactNode; testId?: string }) {
  if (albums.length === 0) return null;
  return (
    <section className="mt-8" data-testid={testId}>
      <h2 className="mb-3 text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-5">{albums.map(tile)}</ul>
    </section>
  );
}

type ParrotAlbumTileProps = {
  album: { id: string; title: string; artistName: string; year?: number | null };
  /** The album's own picture (PAR-META-04); without one, or when it fails to load, the drawn picture shows. */
  src?: string | null;
  /** Shown when the album has no artist name. */
  unknownArtist: string;
  /** Green ring, equaliser badge and green title: this album is the one playing. */
  playing?: boolean;
  /** The badge's bars move only while the music really plays. */
  animated?: boolean;
  onOpen: () => void;
  /** Opens the album artist's page from the artist's name under the title (PAR-NAV-05); plain text without it. */
  onOpenArtist?: () => void;
  /** Play in the middle of the cover on hover or focus, and the "..." menu (PAR-CARD-01). */
  controls?: ParrotCardControls;
  /** Offline and not kept here: greyed out, does not open, no card controls (PAR-OFFL-04). */
  unavailable?: boolean;
  /**
   * PAR-UP-07: the label of an import still adding songs to this album ("Importing…"). The tile shows greyed with
   * the label over its cover, like a film still uploading in Badger; its songs already in the library still play.
   */
  importing?: string | null;
  /** PAR-UP-07: the album's cover is still being fetched: a shimmer instead of the drawn picture. */
  fetching?: boolean;
  testId?: string;
};

/** One album in the grid: its art, its title, then artist · year; the artist's name opens the artist (PAR-NAV-05). */
export function ParrotAlbumTile({ album, src, unknownArtist, playing = false, animated = false, onOpen, onOpenArtist, controls, unavailable = false, importing = null, fetching = false, testId = "album-tile" }: ParrotAlbumTileProps) {
  const artistLine = (
    <>
      {album.artistName || unknownArtist}
      {album.year ? ` · ${album.year}` : ""}
    </>
  );
  // The artist's name is its own button beside the tile's, never inside it (a button may not hold another).
  const artistLinked = Boolean(onOpenArtist && album.artistName && !unavailable);
  return (
    <li className="group relative">
      <button
        type="button"
        className={cn("w-full text-left", unavailable && UNAVAILABLE_CLASS)}
        onClick={onOpen}
        disabled={unavailable}
        data-testid={testId}
        data-playing={playing}
        data-unavailable={unavailable || undefined}
        data-importing={importing ? true : undefined}
      >
        <span className="relative block">
          <ParrotCover
            seed={album.id}
            src={src}
            label={album.title}
            playing={playing}
            animated={animated}
            fetching={fetching}
            className={cn("w-full transition-transform duration-200 group-hover:-translate-y-0.5", importing && "opacity-60 grayscale")}
          />
          {importing && (
            <span className="pointer-events-none absolute inset-x-[8%] bottom-[8%] flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white" data-testid={`${testId}-importing`}>
              <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" aria-hidden />
              <span className="truncate">{importing}</span>
            </span>
          )}
        </span>
        <p className={cn("mt-2.5 truncate text-sm font-semibold", playing && "text-primary", importing && "text-muted-foreground")}>{album.title}</p>
        {!artistLinked && <p className="truncate text-xs text-muted-foreground">{artistLine}</p>}
      </button>
      {artistLinked && (
        <p className="truncate text-xs text-muted-foreground">
          <ParrotNameLink onOpen={onOpenArtist} testId={`${testId}-artist`}>
            {album.artistName}
          </ParrotNameLink>
          {album.year ? ` · ${album.year}` : ""}
        </p>
      )}
      {controls && !unavailable && <ParrotCardOverlay controls={controls} testId={testId} />}
    </li>
  );
}

/** One artist in the grid: a round picture (the artist's photo when it has one), the name, then a detail line (albums · songs). */
export function ParrotArtistTile({
  id,
  src,
  name,
  detail,
  onOpen,
  controls,
  unavailable = false,
  fetching = false,
  testId = "artist-tile",
}: {
  id: string;
  /** The artist's photo (PAR-META-15); the drawn picture while it has none. */
  src?: string | null;
  name: string;
  detail: string;
  onOpen: () => void;
  controls?: ParrotCardControls;
  unavailable?: boolean;
  /** PAR-UP-07: the artist's photo is still being fetched: a shimmer instead of the drawn picture. */
  fetching?: boolean;
  testId?: string;
}) {
  return (
    <li className="group relative">
      <button type="button" className={cn("w-full text-center", unavailable && UNAVAILABLE_CLASS)} onClick={onOpen} disabled={unavailable} data-testid={testId} data-unavailable={unavailable || undefined}>
        <ParrotCover seed={id} src={src} fetching={fetching} className="w-full transition-transform duration-200 group-hover:-translate-y-0.5" rounded="rounded-full" />
        <p className="mt-2.5 truncate text-sm font-semibold">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </button>
      {controls && !unavailable && <ParrotCardOverlay controls={controls} rounded="rounded-full" testId={testId} />}
    </li>
  );
}

export type ParrotChip<T extends string> = { value: T; label: string; testId?: string };

/** The round chips that switch the library between its lists; the picked one is green. */
export function ParrotChips<T extends string>({ chips, value, onChange, className }: { chips: ParrotChip<T>[]; value: T; onChange: (value: T) => void; className?: string }) {
  return (
    <nav className={cn("flex gap-2", className)}>
      {chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          aria-pressed={value === chip.value}
          onClick={() => onChange(chip.value)}
          data-testid={chip.testId}
          className={cn(
            "h-8 rounded-full border px-4 text-xs font-semibold transition-colors",
            value === chip.value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground"
          )}
        >
          {chip.label}
        </button>
      ))}
    </nav>
  );
}

/** Back to the list the page was opened from. */
export function ParrotBackButton({ label, onClick, testId = "library-back" }: { label: string; onClick: () => void; testId?: string }) {
  return <BackButton label={label} onClick={onClick} className="mb-4" testId={testId} />;
}

type ParrotPageHeaderProps = {
  /** The album's cover, or the artist's round picture. */
  cover: ReactNode;
  /** The small green word over the title ("Album", "Artist"). */
  kicker: string;
  title: ReactNode;
  titleTestId?: string;
  /** The line under the title: artist · year · songs, or albums · songs. */
  detail: ReactNode;
  /** The play buttons. */
  actions: ReactNode;
};

/** The head of an album or artist page: big art on the left, kicker, title, detail line and play buttons. */
export function ParrotPageHeader({ cover, kicker, title, titleTestId, detail, actions }: ParrotPageHeaderProps) {
  return (
    <div className="mb-8 flex flex-wrap items-end gap-8">
      {cover}
      <div className="min-w-0 space-y-3">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-primary">{kicker}</p>
        <h1 className="font-['Space_Grotesk'] text-4xl font-bold tracking-tight md:text-5xl" data-testid={titleTestId}>
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
        {actions}
      </div>
    </div>
  );
}

/** The big cover of an album page; `fetching`: its picture is still on its way (a shimmer, PAR-META-20). */
export function ParrotAlbumPageCover({ id, src, title, playing, animated, fetching }: { id: string; src?: string | null; title?: string; playing: boolean; animated: boolean; fetching?: boolean }) {
  return <ParrotCover seed={id} src={src} fetching={fetching} label={title} playing={playing} animated={animated} className="w-56 shadow-2xl shadow-black/50" />;
}

/** Who took an artist's photo and under which licence (a Commons photo, PAR-META-15). */
export type ParrotPhotoCredit = { author: string; licence: string; licenceUrl: string | null };

const LICENCE_SLOT = "\u0000";

/**
 * A photo's credit line ("Photo: author, licence", the licence linking to its text, PAR-META-15). `creditLabel` is the
 * translated line; the licence's place in it is found by asking for it with a marker, so every language may put it
 * where it likes.
 */
export function ParrotPhotoCreditLine({
  credit,
  creditLabel = (author, licence) => `Photo: ${author}, ${licence}`,
  className,
}: {
  credit: ParrotPhotoCredit;
  creditLabel?: (author: string, licence: string) => string;
  className?: string;
}) {
  const [before, after = ""] = creditLabel(credit.author, LICENCE_SLOT).split(LICENCE_SLOT);
  return (
    <figcaption className={cn("mt-2 text-center text-[11px] leading-snug text-muted-foreground", className)} data-testid="artist-photo-credit">
      {before}
      {credit.licenceUrl ? (
        <a href={credit.licenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground" data-testid="artist-photo-licence">
          {credit.licence}
        </a>
      ) : (
        credit.licence
      )}
      {after}
    </figcaption>
  );
}

/** The round picture of an artist page: the artist's photo when it has one, with its credit line under it. */
export function ParrotArtistPageCover({
  id,
  src,
  credit,
  creditLabel,
  fetching = false,
}: {
  id: string;
  src?: string | null;
  credit?: ParrotPhotoCredit | null;
  creditLabel?: (author: string, licence: string) => string;
  /** PAR-UP-07: the photo is still being fetched: a shimmer instead of the drawn picture. */
  fetching?: boolean;
}) {
  const cover = <ParrotCover seed={id} src={src} fetching={fetching} className="w-40" rounded="rounded-full" />;
  if (!src || !credit) return cover;
  return (
    <figure className="w-40 shrink-0">
      {cover}
      <ParrotPhotoCreditLine credit={credit} creditLabel={creditLabel} />
    </figure>
  );
}

export type ParrotSongListTrack = {
  id: string;
  title: string;
  artistName?: string | null;
  /** The song's artist and album, so their names open their pages (PAR-NAV-05); '' or absent: plain text. */
  artistId?: string | null;
  albumTitle?: string | null;
  albumId?: string | null;
  durationMs: number | null;
  /** Kept as is at import, matched to nothing: the row says so (PAR-UP-05). */
  unidentified?: boolean;
};

/** Where a song row's artist and album names lead (PAR-NAV-05). */
export type ParrotNameLinks = { onOpenArtist: (id: string) => void; onOpenAlbum: (id: string) => void };

type ParrotSongListProps<T extends ParrotSongListTrack> = {
  tracks: T[];
  /** The song playing now, if it is in this list. */
  playingId: string | undefined;
  /** The equaliser moves only while the music really plays. */
  playing: boolean;
  showAlbum: boolean;
  /** Column titles and the play button's name, already translated. */
  labels: {
    song: string;
    artist: string;
    album: string;
    time: string;
    unknownArtist: string;
    play: (title: string) => string;
    /** The note on a song of the album the user does not have (PAR-LIB-05); needed with `rows`. */
    missing?: string;
    /** The mark on a song kept as is at import (PAR-UP-05). */
    unidentified?: string;
  };
  /** Plays this list from the picked song: the rest of the list follows in the queue. */
  onPlay: (index: number) => void;
  /** Extra buttons at the end of a row (play next, add to queue, remove from a playlist); `index` is the row's place in the list. */
  actions?: (track: T, index: number) => ReactNode;
  /** Offline: the songs not kept here, greyed out and not played; their row buttons stay (PAR-OFFL-04). */
  unavailable?: (track: T) => boolean;
  testId?: string;
  rowTestId?: string;
  /**
   * An album page's rows (`albumPageRows`): the songs of `tracks` with the album's missing songs slotted in, greyed
   * and not playable (PAR-LIB-05). `onPlay` and `actions` still get each song's index in `tracks`.
   */
  rows?: ParrotAlbumRow<T>[];
  /** Makes each row's artist and album names open their pages (PAR-NAV-05). */
  links?: ParrotNameLinks;
};

/**
 * The list's columns, laid once on the list and shared by the header and every row (subgrid), so a column's
 * heading sits over its values and an `auto` column (length, buttons) is as wide in every row. Wide (the list at
 * least 32rem across): play, title, artist, album (Songs list), length, buttons. Narrow (a phone-width window): play,
 * title with the artist under it, length, and the row's buttons on a line of their own under the title — the artist
 * and album columns, or four buttons beside the title, would otherwise leave a few letters of each title. Literal
 * classes, so Tailwind finds them.
 */
const SONG_LIST_COLUMNS = {
  plain: "grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_4rem]",
  actions: "grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_4rem_auto]",
  album: "grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_4rem]",
  albumActions: "grid-cols-[2.5rem_minmax(0,1fr)_auto] @lg:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_4rem_auto]",
};

/** Songs one per row: play button (equaliser while playing), title, artist, album (in the Songs list), length. */
export function ParrotSongList<T extends ParrotSongListTrack>({ tracks, playingId, playing, showAlbum, labels, onPlay, actions, unavailable, rows, links, testId = "library-tracks", rowTestId = "library-track" }: ParrotSongListProps<T>) {
  const columns = SONG_LIST_COLUMNS[showAlbum ? (actions ? "albumActions" : "album") : actions ? "actions" : "plain"];
  return (
    <div className="@container text-sm">
      <div className={cn("grid gap-x-3", columns)}>
        <div className="col-span-full grid grid-cols-subgrid border-b border-border px-2 pb-2 text-[11px] font-black uppercase tracking-[0.12em] text-muted-foreground" aria-hidden>
          <span />
          <span>{labels.song}</span>
          <span className="hidden @lg:block">{labels.artist}</span>
          {showAlbum && <span className="hidden @lg:block">{labels.album}</span>}
          <span className="text-right">{labels.time}</span>
          {actions && <span className="hidden @lg:block" />}
        </div>
        <ol className="col-span-full grid grid-cols-subgrid" data-testid={testId}>
          {(rows ?? tracks.map((track, index): ParrotAlbumRow<T> => ({ kind: "owned", track, index }))).map((row) => {
            if (row.kind === "missing") {
              const { listed } = row;
              // Like Badger's missing episodes: greyed, no play button, no actions; never in the play queue.
              return (
                <li
                  key={`missing:${listed.disc}:${listed.number}`}
                  className="col-span-full grid cursor-default grid-cols-subgrid items-center rounded-md px-2 py-1.5 opacity-40 grayscale"
                  aria-disabled
                  data-testid="library-missing-track"
                >
                  <span className="flex h-8 w-8 items-center justify-center text-xs tabular-nums text-muted-foreground">{listed.number}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium" title={listed.title}>
                      {listed.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{labels.missing}</span>
                  </span>
                  <span className="hidden @lg:block" />
                  {showAlbum && <span className="hidden @lg:block" />}
                  <span className="text-right tabular-nums text-muted-foreground">{formatDuration(listed.durationMs)}</span>
                  {actions && <span className="hidden @lg:block" />}
                </li>
              );
            }
            const { track, index: i } = row;
            return (
            // UX-CRASH-01: a song row that throws shows a placeholder in its place; the other rows stay.
            <RenderBoundary key={`${track.id}:${i}`} name={`${rowTestId}:${track.id}`} variant="item" className="col-span-full">
            {() => {
            const isCurrent = playingId === track.id;
            const away = unavailable?.(track) ?? false;
            const artist = track.artistName || labels.unknownArtist;
            const openArtist = links && track.artistId && track.artistName ? () => links.onOpenArtist(track.artistId!) : undefined;
            const openAlbum = links && track.albumId ? () => links.onOpenAlbum(track.albumId!) : undefined;
            return (
              <li
                // A playlist can hold the same song twice.
                key={`${track.id}:${i}`}
                className={cn("col-span-full grid cursor-pointer grid-cols-subgrid items-center rounded-md px-2 py-1.5 hover:bg-secondary/60", isCurrent && "bg-primary/10 text-primary", away && "cursor-default")}
                onDoubleClick={away ? undefined : () => onPlay(i)}
                data-testid={rowTestId}
                data-unavailable={away || undefined}
              >
                <button type="button" className={cn("flex h-8 w-8 items-center justify-center rounded-full hover:bg-secondary", away && UNAVAILABLE_CLASS)} aria-label={labels.play(track.title)} disabled={away} onClick={() => onPlay(i)}>
                  {isCurrent && playing ? <ParrotEqualizer animated /> : <Play className="h-4 w-4 fill-current" />}
                </button>
                <span className={cn("min-w-0", away && UNAVAILABLE_CLASS)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium" title={track.title}>
                      {track.title}
                    </span>
                    {track.unidentified && labels.unidentified && (
                      <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-semibold text-muted-foreground" data-testid="song-unidentified">
                        {labels.unidentified}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground @lg:hidden" title={artist} data-testid="song-artist-under-title">
                    <ParrotNameLink onOpen={openArtist} testId="song-artist-link">
                      {artist}
                    </ParrotNameLink>
                  </span>
                </span>
                <span className={cn("hidden truncate text-muted-foreground @lg:block", away && UNAVAILABLE_CLASS)} title={artist}>
                  <ParrotNameLink onOpen={openArtist} testId="song-artist-link">
                    {artist}
                  </ParrotNameLink>
                </span>
                {showAlbum && (
                  <span className={cn("hidden truncate text-muted-foreground @lg:block", away && UNAVAILABLE_CLASS)} title={track.albumTitle ?? undefined}>
                    <ParrotNameLink onOpen={openAlbum} testId="song-album-link">
                      {track.albumTitle}
                    </ParrotNameLink>
                  </span>
                )}
                <span className={cn("text-right tabular-nums text-muted-foreground", away && UNAVAILABLE_CLASS)}>{formatDuration(track.durationMs)}</span>
                {actions && (
                  <span className="col-span-2 col-start-2 flex items-center @lg:col-span-1 @lg:col-start-auto" data-testid="song-row-actions">
                    {actions(track, i)}
                  </span>
                )}
              </li>
            );
            }}
            </RenderBoundary>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
