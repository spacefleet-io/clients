/**
 * Parrot's screens beyond the library, shared by the browser-engine apps (desktop renderer and web player) and drawn
 * from the approved design (PAR-LOOK-01): Home's "Jump back in" card and its rows, the bottom player bar and the
 * now-playing page. Texts come in already translated; data and playback stay with each app.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ListMusic, Loader2, Mic2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { activeLyricIndex, formatDuration, homeJumpButton, homeRecentlyAdded, homeView } from "@space/parrot-core";
import type { HistoryAlbum, HomeNowPlaying, ListeningHistory, ParrotAlbumSort, ParrotLyrics, RepeatMode } from "@space/parrot-core";
import { Button } from "../button";
import { GuardedItems, RenderBoundary } from "../render-boundary";
import { cn } from "../utils";
import { ParrotCardOverlay, type ParrotCardControls } from "./card-actions";
import { ParrotCover, ParrotEqualizer, ParrotNameLink, ParrotWaveSeek } from "./components";
import { ParrotAlbumTile } from "./library";

const time = (ms: number) => formatDuration(Math.max(0, ms)) || "0:00";

/**
 * How many wave bars fit `width` pixels: each bar needs 3px plus a 2px gap. Drawing all 96 in the ~140px an 800px window
 * leaves gave 190px of gaps alone, so every bar shrank to nothing and the wave vanished (PAR-LOOK-04).
 */
export const waveBarsFor = (width: number) => (width > 0 ? Math.max(16, Math.min(96, Math.floor((width + 2) / 5))) : 96);

/** Measures a box's width as it resizes, for `waveBarsFor`. */
export function useBoxWidth(): [number, (box: HTMLElement | null) => void] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((box: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!box || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.current.observe(box);
  }, []);
  return [width, ref];
}

/** A titled row on Home ("Recently played", "Your artists") with its "See all" on the right: the ghost button, so hovering fills the accent pill (UX-BTN-01). */
export function ParrotShelf({ title, seeAll, onSeeAll, children, testId }: { title: string; seeAll?: string; onSeeAll?: () => void; children: ReactNode; testId?: string }) {
  return (
    <section className="mt-10" data-testid={testId}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="font-['Space_Grotesk'] text-xl font-bold tracking-tight">{title}</h2>
        {seeAll && onSeeAll && (
          <Button variant="ghost" size="sm" className="text-sm text-muted-foreground" onClick={onSeeAll} data-testid={testId ? `${testId}-see-all` : undefined}>
            {seeAll}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * One row of tiles that never wraps: as many as the width holds, like the design's seven albums at 1440px. The row
 * clips the tile that does not fit, so it keeps an 8px margin of its own inside the clip on the top, left and bottom
 * (and takes it back outside with a negative margin, so the tiles sit where they did): the playing album's green ring
 * is drawn 5px outside its cover and the tile lifts 2px on hover, and without that margin the row cut off the ring's
 * top and left side. The right side keeps its clip where it was, so the tile that does not fit shows no more of itself.
 */
export function ParrotShelfRow({ kind = "album", children, testId }: { kind?: "album" | "artist"; children: ReactNode; testId?: string }) {
  return (
    <ul
      className={cn(
        "-my-2 -ml-2 grid grid-flow-col gap-6 overflow-hidden py-2 pl-2",
        kind === "album" ? "auto-cols-[minmax(10.5rem,12rem)] grid-rows-1" : "auto-cols-[minmax(7.5rem,8.5rem)] grid-rows-1"
      )}
      data-testid={testId}
    >
      {/* UX-CRASH-01: a tile that throws shows a placeholder in its place; the rest of the row stays. */}
      <GuardedItems name={testId ?? `${kind}-row`} className="aspect-square">
        {children}
      </GuardedItems>
    </ul>
  );
}

/** A round artist picture (the artist's photo when it has one, PAR-META-15) with the name under it, for Home's "Your artists". */
export function ParrotArtistCircle({
  id,
  src,
  name,
  onOpen,
  controls,
  fetching = false,
  testId = "home-artist",
}: {
  id: string;
  src?: string | null;
  name: string;
  onOpen: () => void;
  controls?: ParrotCardControls;
  /** PAR-UP-07: the artist's photo is still being fetched: a shimmer instead of the drawn picture. */
  fetching?: boolean;
  testId?: string;
}) {
  return (
    <li className="group relative">
      <button type="button" className="w-full text-center" onClick={onOpen} data-testid={testId}>
        <ParrotCover seed={id} src={src} fetching={fetching} rounded="rounded-full" className="w-full transition-transform duration-200 group-hover:-translate-y-0.5" />
        <p className="mt-2.5 line-clamp-2 text-sm font-semibold">{name}</p>
      </button>
      {controls && <ParrotCardOverlay controls={controls} rounded="rounded-full" testId={testId} />}
    </li>
  );
}

type JumpBackInProps = {
  album: { id: string; title: string };
  src?: string | null;
  /** The cover is still on its way (a shimmer, PAR-META-20). */
  fetching?: boolean;
  kicker: string;
  detail: string;
  /** "Pause" while the album plays, "Resume 1:18" where it stands or stopped, or "Play" for an album not started here. */
  primaryLabel: string;
  /** The main button pauses the playing song: it shows the pause icon. */
  primaryPauses: boolean;
  shuffleLabel: string;
  onPrimary: () => void;
  onShuffle: () => void;
  onOpen: () => void;
  playing: boolean;
  animated: boolean;
  /** The wave on the right: the song to resume and how far into it, 0 to 1. */
  waveSeed: string;
  waveProgress: number;
  waveLabel: string;
};

/** Home's "Jump back in" card: the last album played here, with Resume and Shuffle and the song's wave. */
export function ParrotJumpBackIn(props: JumpBackInProps) {
  const { album, src, kicker, detail, primaryLabel, primaryPauses, shuffleLabel, onPrimary, onShuffle, onOpen, playing, animated, waveSeed, waveProgress, waveLabel } = props;
  const [waveWidth, waveBox] = useBoxWidth();
  return (
    <section
      className="flex items-center gap-7 rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/10 via-card/60 to-card/40 p-6 shadow-[0_0_40px_-20px_hsl(var(--primary))]"
      data-testid="home-jump-back-in"
    >
      <button type="button" className="shrink-0" onClick={onOpen} aria-label={album.title} data-testid="home-jump-cover">
        <ParrotCover seed={album.id} src={src} fetching={props.fetching} label={album.title} playing={playing} animated={animated} className="h-[148px] w-[148px]" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">{kicker}</p>
        <h1 className="mt-1 truncate font-['Space_Grotesk'] text-4xl font-bold tracking-tight" data-testid="home-jump-title">
          {album.title}
        </h1>
        <p className="mt-1 truncate text-muted-foreground">{detail}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button className="rounded-full px-5" onClick={onPrimary} data-testid="home-resume">
            {primaryPauses ? <Pause className="mr-2 h-4 w-4 fill-current" aria-hidden /> : <Play className="mr-2 h-4 w-4 fill-current" aria-hidden />}
            {primaryLabel}
          </Button>
          <Button variant="outline" className="rounded-full px-5" onClick={onShuffle} data-testid="home-shuffle">
            <Shuffle className="mr-2 h-4 w-4" aria-hidden />
            {shuffleLabel}
          </Button>
        </div>
      </div>
      <div ref={waveBox} className="hidden w-[30%] max-w-[380px] self-end pb-2 lg:block" aria-hidden>
        <ParrotWaveSeek seed={waveSeed} progress={waveProgress} label={waveLabel} bars={Math.min(72, waveBarsFor(waveWidth))} height={40} testId="home-jump-wave" />
      </div>
    </section>
  );
}

export type ParrotPlayerBarLabels = {
  play: string;
  pause: string;
  previous: string;
  next: string;
  shuffle: string;
  repeatOff: string;
  repeatAll: string;
  repeatOne: string;
  seek: string;
  lyrics: string;
  queue: string;
  openNowPlaying: string;
  error: string;
};

type ParrotPlayerBarProps = {
  track: { id: string; title: string; artistName: string; artistId?: string | null; albumTitle: string; albumId: string };
  coverSrc?: string | null;
  /** The cover is still on its way (a shimmer, PAR-META-20). */
  coverFetching?: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  error: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  canPrevious: boolean;
  canNext: boolean;
  labels: ParrotPlayerBarLabels;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onSeek?: (fraction: number) => void;
  /** The page the player opens on: lyrics or the queue; the title and cover open it too. */
  onOpen: (tab: "lyrics" | "queue" | null) => void;
  /** The artist's and the album's names open their pages (PAR-NAV-05); plain text without them. */
  onOpenArtist?: (id: string) => void;
  onOpenAlbum?: (id: string) => void;
  /** Which now-playing tab is open, if any: its button is lit. */
  openTab?: "lyrics" | "queue" | null;
  /** The like button (PAR-PL-04), next to the title. */
  like?: ReactNode;
  /** The volume control, at the far right (PAR-PLAY-05). */
  volume: ReactNode;
};

const iconButton = "h-9 w-9 text-muted-foreground hover:bg-white/5 hover:text-foreground";

/**
 * The bottom player bar in the approved design (PAR-LOOK-01): cover, title and artist and the like button; shuffle,
 * previous, play, next and repeat over the waveform seek bar; lyrics, queue and volume on the right.
 */
export function ParrotPlayerBar(props: ParrotPlayerBarProps) {
  const { track, coverSrc, playing, positionMs, durationMs, error, shuffle, repeat, canPrevious, canNext, labels, openTab = null } = props;
  const [waveWidth, waveBox] = useBoxWidth();
  const repeatLabel = repeat === "one" ? labels.repeatOne : repeat === "all" ? labels.repeatAll : labels.repeatOff;
  return (
    <footer
      className="grid min-h-[88px] grid-cols-[1fr_1.25fr_1fr] items-center gap-6 border-t border-[#30363d] bg-[rgba(13,17,23,0.94)] px-6 backdrop-blur-xl"
      data-testid="player"
    >
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" className="shrink-0" onClick={() => props.onOpen(null)} aria-label={labels.openNowPlaying} data-testid="player-open">
          <ParrotCover seed={track.albumId} src={coverSrc} fetching={props.coverFetching} playing animated={playing} className="h-14 w-14 shrink-0" />
        </button>
        <span className="min-w-0" data-testid="player-title">
          <button type="button" className="block max-w-full truncate text-left text-sm font-semibold" onClick={() => props.onOpen(null)}>
            {track.title}
          </button>
          <span className="block truncate text-xs text-muted-foreground">
            <ParrotNameLink onOpen={track.artistId && props.onOpenArtist ? () => props.onOpenArtist!(track.artistId!) : undefined} testId="player-artist-link">
              {track.artistName}
            </ParrotNameLink>
            {" · "}
            <ParrotNameLink onOpen={track.albumId && props.onOpenAlbum ? () => props.onOpenAlbum!(track.albumId) : undefined} testId="player-album-link">
              {track.albumTitle}
            </ParrotNameLink>
          </span>
        </span>
        {props.like}
      </div>
      <div className="flex min-w-0 flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconButton, shuffle && "text-primary hover:text-primary")}
            aria-label={labels.shuffle}
            aria-pressed={shuffle}
            title={labels.shuffle}
            onClick={props.onShuffle}
            data-testid="player-shuffle"
          >
            <Shuffle className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={labels.previous} title={labels.previous} disabled={!canPrevious} onClick={props.onPrevious} data-testid="player-previous">
            <SkipBack className="h-5 w-5 fill-current" />
          </Button>
          <Button size="icon" className="h-10 w-10 rounded-full" aria-label={playing ? labels.pause : labels.play} data-testid="player-toggle" onClick={props.onToggle}>
            {playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label={labels.next} title={labels.next} disabled={!canNext} onClick={props.onNext} data-testid="player-next">
            <SkipForward className="h-5 w-5 fill-current" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconButton, repeat !== "off" && "text-primary hover:text-primary")}
            aria-label={repeatLabel}
            title={repeatLabel}
            data-repeat={repeat}
            onClick={props.onRepeat}
            data-testid="player-repeat"
          >
            {repeat === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
          </Button>
        </div>
        {error ? (
          <div className="text-xs text-destructive">{labels.error}</div>
        ) : (
          <div className="flex w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground" data-testid="player-time">
            <span className="w-10 text-right">{time(positionMs)}</span>
            <div ref={waveBox} className="flex min-w-0 flex-1" data-testid="player-wave-box">
              <ParrotWaveSeek
                seed={track.id}
                progress={durationMs ? positionMs / durationMs : 0}
                onSeek={durationMs ? props.onSeek : undefined}
                label={labels.seek}
                valueText={`${time(positionMs)} / ${time(durationMs)}`}
                bars={waveBarsFor(waveWidth)}
                testId="player-seek"
              />
            </div>
            <span className="w-10">{time(durationMs)}</span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, openTab === "lyrics" && "text-primary hover:text-primary")}
          aria-label={labels.lyrics}
          aria-pressed={openTab === "lyrics"}
          title={labels.lyrics}
          onClick={() => props.onOpen("lyrics")}
          data-testid="player-lyrics"
        >
          <Mic2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(iconButton, openTab === "queue" && "text-primary hover:text-primary")}
          aria-label={labels.queue}
          aria-pressed={openTab === "queue"}
          title={labels.queue}
          onClick={() => props.onOpen("queue")}
          data-testid="player-queue"
        >
          <ListMusic className="h-4 w-4" />
        </Button>
        {props.volume}
      </div>
    </footer>
  );
}

export type ParrotNowPlayingTab = "lyrics" | "queue" | "about";

export type ParrotNowPlayingLabels = {
  lyrics: string;
  queue: string;
  about: string;
  noLyricsTitle: string;
  noLyricsBody: string;
  /**
   * The final state once every source was asked and none has lyrics (PAR-LYR-04): "No lyrics" and where Parrot looked.
   * Left out where the app never looks lyrics up; then "No lyrics yet" stays.
   */
  noLyricsFoundTitle?: string;
  noLyricsFoundBody?: string;
  /** While a lookup for the song is queued or running (PAR-LYR-06): "Looking for lyrics…", never a "No lyrics" yet. */
  searchingLyricsTitle: string;
  searchingLyricsBody: string;
  /** The small line under the lyrics naming where they come from ("Synced lyrics from your file"). */
  syncedLyricsSource: string;
  plainLyricsSource: string;
  /** The same line for lyrics fetched from our lyrics library (PAR-LYR-05). */
  fetchedSyncedLyricsSource: string;
  fetchedPlainLyricsSource: string;
  nothingNext: string;
  nowPlaying: string;
  /** `onOpen`: the value is an artist or album name that opens its page (PAR-NAV-05). */
  aboutRows: { label: string; value: string; onOpen?: () => void }[];
};

/**
 * The lyrics "Search again" button (PAR-LYR-05): `busy` while the lookup runs (the tab shows "Looking for lyrics…",
 * PAR-LYR-06), `none` once the lookup had nothing for it, `failed` when it could not be reached. The button only shows
 * once a lookup came back empty or failed (`lyrics.notFound` included), never while one runs (PAR-META-20).
 */
export type ParrotLyricsFetchControl = {
  state: "idle" | "busy" | "none" | "failed";
  onFetch: () => void;
  labels: { body: string; button: string; none: string; failed: string };
};

type NowPlayingEntry = { key: number; track: { id: string; title: string; artistName: string; artistId?: string | null; albumId: string; durationMs: number | null } };

type ParrotNowPlayingProps = {
  track: { id: string; title: string; artistName: string; artistId?: string | null; albumTitle: string; albumId: string };
  coverSrc?: string | null;
  /** The cover is still on its way (a shimmer, PAR-META-20). */
  coverFetching?: boolean;
  playing: boolean;
  tab: ParrotNowPlayingTab;
  onTab: (tab: ParrotNowPlayingTab) => void;
  /** The queue in play order and the place of the song playing now. */
  entries: NowPlayingEntry[];
  position: number;
  onJump: (index: number) => void;
  /** Pauses or resumes the song playing now: what a click on its queue row does (PAR-PLAY-10). */
  onToggle: () => void;
  coverFor: (albumId: string) => string | null | undefined;
  labels: ParrotNowPlayingLabels;
  /** The like button (PAR-PL-04), next to the title. */
  like?: ReactNode;
  onOpenAlbum: () => void;
  /** The artist's name, under the title and in the queue, opens the artist's page (PAR-NAV-05). */
  onOpenArtist?: (id: string) => void;
  /**
   * The song's lyrics (PAR-LYR-01), null when it has none; synced lines follow `positionMs`. Undefined while the app is
   * still reading them, so neither "No lyrics yet" nor "No lyrics" shows before it knows.
   */
  lyrics: ParrotLyrics | null | undefined;
  positionMs: number;
  /** Jumps the song to a line's start when the line is clicked. */
  onSeek?: (ms: number) => void;
  /** Offers to fetch the lyrics of a song with none; left out where the app cannot fetch them. */
  fetchLyrics?: ParrotLyricsFetchControl;
};

/**
 * The Lyrics tab's words. Synced lines (PAR-LYR-01) light up as they are sung, as in the design: the line sung now big
 * and green, the ones sung dim, the next ones half bright, the list scrolling to keep the current line in view; a
 * click on a line plays from there. Plain lyrics show as written. While a lookup for the song is queued or running
 * (the automatic one, `lyrics.searching`, or the app's own, state `busy`), it says "Looking for lyrics…" with a
 * spinner (PAR-LYR-06). A song with none says "No lyrics yet" (PAR-LYR-04); once the lookup came back empty it says
 * "No lyrics" with "Search again" (PAR-LYR-05), so loading never looks like nothing found (PAR-META-20).
 */
export function ParrotLyricsPane({ lyrics, positionMs, onSeek, labels, fetchLyrics }: Pick<ParrotNowPlayingProps, "lyrics" | "positionMs" | "onSeek" | "labels" | "fetchLyrics">) {
  const active = lyrics?.synced ? activeLyricIndex(lyrics.synced, positionMs) : -1;
  const current = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [active]);
  if (lyrics?.synced) {
    return (
      <div className="max-w-2xl">
        <div className="flex max-h-[min(60vh,560px)] flex-col gap-5 overflow-y-auto pb-24 pr-2 [scrollbar-width:none]" data-testid="lyrics-synced">
          {lyrics.synced.map((line, index) => {
            const state = index === active ? "now" : index < active ? "past" : "next";
            return (
              <button
                key={`${line.ms}-${index}`}
                ref={index === active ? current : undefined}
                type="button"
                disabled={!onSeek}
                onClick={() => onSeek?.(line.ms)}
                className={cn(
                  "text-left font-['Space_Grotesk'] font-bold leading-tight transition-all duration-300 disabled:cursor-default",
                  state === "now" ? "text-4xl text-primary" : "text-3xl",
                  state === "past" && "text-foreground/30 hover:text-foreground/60",
                  state === "next" && "text-foreground/55 hover:text-foreground/80"
                )}
                data-testid="lyrics-line"
                data-state={state}
              >
                {line.text || "♪"}
              </button>
            );
          })}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">{lyrics.fetched ? labels.fetchedSyncedLyricsSource : labels.syncedLyricsSource}</p>
      </div>
    );
  }
  if (lyrics?.plain) {
    return (
      <div className="max-w-2xl">
        <p className="max-h-[min(60vh,560px)] overflow-y-auto whitespace-pre-line text-xl font-semibold leading-relaxed text-foreground/80" data-testid="lyrics-plain">
          {lyrics.plain}
        </p>
        <p className="mt-6 text-xs text-muted-foreground">{lyrics.fetched ? labels.fetchedPlainLyricsSource : labels.plainLyricsSource}</p>
      </div>
    );
  }
  if (lyrics === undefined) return <div className="max-w-xl" data-testid="lyrics-reading" aria-busy="true" />;
  if (lyrics?.searching || fetchLyrics?.state === "busy") {
    return (
      <div className="max-w-xl" data-testid="lyrics-searching" role="status" aria-live="polite">
        <p className="flex items-center gap-3 font-['Space_Grotesk'] text-3xl font-bold text-muted-foreground/70">
          <Loader2 className="h-7 w-7 animate-spin" aria-hidden />
          {labels.searchingLyricsTitle}
        </p>
        <p className="mt-3 text-sm text-muted-foreground" data-testid="lyrics-fetch-message">
          {labels.searchingLyricsBody}
        </p>
      </div>
    );
  }
  const notFound = Boolean(lyrics?.notFound || fetchLyrics?.state === "none") && Boolean(labels.noLyricsFoundTitle);
  const title = notFound ? labels.noLyricsFoundTitle : labels.noLyricsTitle;
  if (fetchLyrics) {
    const { state, labels: fetchLabels } = fetchLyrics;
    const body =
      state === "failed" ? fetchLabels.failed : notFound ? (labels.noLyricsFoundBody ?? fetchLabels.none) : state === "none" ? fetchLabels.none : fetchLabels.body;
    return (
      <div className="max-w-xl" data-testid="lyrics-none" data-fetch={state} data-found={notFound ? "none" : undefined}>
        <p className="font-['Space_Grotesk'] text-3xl font-bold text-muted-foreground/70">{title}</p>
        <p className="mt-3 text-sm text-muted-foreground" data-testid="lyrics-fetch-message">
          {body}
        </p>
        {(notFound || state === "none" || state === "failed") && (
          <Button className="mt-6 rounded-full px-5" onClick={fetchLyrics.onFetch} data-testid="lyrics-fetch">
            <Mic2 className="mr-2 h-4 w-4" aria-hidden />
            {fetchLabels.button}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-xl" data-testid="lyrics-none" data-found={notFound ? "none" : undefined}>
      <p className="font-['Space_Grotesk'] text-3xl font-bold text-muted-foreground/70">{title}</p>
      <p className="mt-3 text-sm text-muted-foreground">{notFound ? labels.noLyricsFoundBody : labels.noLyricsBody}</p>
    </div>
  );
}

/**
 * The now-playing page (PAR-LOOK-01): the large cover with the title, artist and album under it, and on the right the
 * Lyrics / Up next / About tabs. The Lyrics tab shows the song's own lyrics, synced line by line when they can be
 * (`ParrotLyricsPane`), and says "No lyrics yet" plainly for a song with none (PAR-LYR-04).
 */
export function ParrotNowPlaying(props: ParrotNowPlayingProps) {
  const { track, coverSrc, playing, tab, labels, entries, position } = props;
  const tabs: { value: ParrotNowPlayingTab; label: string }[] = [
    { value: "lyrics", label: labels.lyrics },
    { value: "queue", label: labels.queue },
    { value: "about", label: labels.about },
  ];
  return (
    <section className="grid grid-cols-[minmax(0,520px)_1fr] gap-16 px-10 py-10" data-testid="now-playing">
      <div className="min-w-0">
        <button type="button" className="block w-full" onClick={props.onOpenAlbum} aria-label={track.albumTitle} data-testid="now-playing-cover">
          <ParrotCover seed={track.albumId} src={coverSrc} fetching={props.coverFetching} label={track.albumTitle} className="w-full shadow-2xl" />
        </button>
        <div className="mt-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-['Space_Grotesk'] text-3xl font-bold tracking-tight" data-testid="now-playing-title">
              {track.title}
            </h1>
            <p className="mt-1 truncate text-muted-foreground">
              <ParrotNameLink onOpen={track.artistId && props.onOpenArtist ? () => props.onOpenArtist!(track.artistId!) : undefined} testId="now-playing-artist-link">
                {track.artistName}
              </ParrotNameLink>
              {" · "}
              <ParrotNameLink onOpen={props.onOpenAlbum} testId="now-playing-album-link">
                {track.albumTitle}
              </ParrotNameLink>
            </p>
          </div>
          {props.like}
        </div>
      </div>
      <div className="min-w-0">
        <div className="inline-flex gap-1 rounded-full border border-[#30363d] bg-card/60 p-1" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-semibold transition-colors",
                tab === item.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => props.onTab(item.value)}
              data-testid={`now-playing-tab-${item.value}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-8" data-testid={`now-playing-${tab}`}>
          {tab === "lyrics" && (
            <ParrotLyricsPane lyrics={props.lyrics} positionMs={props.positionMs} onSeek={props.onSeek} labels={labels} fetchLyrics={props.fetchLyrics} />
          )}
          {tab === "queue" && (
            <ol className="max-w-2xl space-y-1">
              {entries.slice(position).map((entry, offset) => {
                const index = position + offset;
                const current = offset === 0;
                return (
                  // The row's button lies under the whole row; the artist's name sits over it so it opens the artist
                  // instead (PAR-NAV-05): a button may not hold another.
                  <li key={entry.key} className={cn("relative flex w-full items-center gap-3 rounded-lg px-2 py-2 hover:bg-card/70", current && "bg-card/60")}>
                    <button
                      type="button"
                      className="absolute inset-0 rounded-lg"
                      onClick={() => (current ? props.onToggle() : props.onJump(index))}
                      aria-label={entry.track.title}
                      data-testid="now-playing-queue-row"
                      data-current={current}
                    />
                    <ParrotCover seed={entry.track.albumId} src={props.coverFor(entry.track.albumId)} className="pointer-events-none h-10 w-10 shrink-0" />
                    <span className="pointer-events-none min-w-0 flex-1">
                      <span className={cn("block truncate text-sm font-semibold", current && "text-primary")}>{entry.track.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {current ? (
                          labels.nowPlaying
                        ) : (
                          <ParrotNameLink
                            className="pointer-events-auto relative"
                            onOpen={entry.track.artistId && props.onOpenArtist ? () => props.onOpenArtist!(entry.track.artistId!) : undefined}
                            testId="now-playing-queue-artist-link"
                          >
                            {entry.track.artistName}
                          </ParrotNameLink>
                        )}
                      </span>
                    </span>
                    {current ? <ParrotEqualizer animated={playing} /> : <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(entry.track.durationMs)}</span>}
                  </li>
                );
              })}
              {entries.length - position <= 1 && <li className="px-2 py-3 text-sm text-muted-foreground">{labels.nothingNext}</li>}
            </ol>
          )}
          {tab === "about" && (
            <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-sm">
              {labels.aboutRows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="truncate font-medium">
                    <ParrotNameLink onOpen={row.onOpen}>{row.value}</ParrotNameLink>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}

export type ParrotHomeLabels = {
  jumpBackIn: string;
  startListening: string;
  resume: (time: string) => string;
  play: string;
  pause: string;
  shuffle: string;
  recentlyAdded: string;
  recentlyPlayed: string;
  albums: string;
  yourArtists: string;
  seeAll: string;
  unknownArtist: string;
};

type ParrotHomeAlbum = { id: string; title: string; artistName: string; year: number | null; addedAt: number };

type ParrotHomeProps<A extends ParrotHomeAlbum, R extends { id: string; name: string }, T extends { id: string; title: string; albumId: string; durationMs: number | null }> = {
  history: ListeningHistory;
  albums: readonly A[];
  artists: readonly R[];
  tracks: readonly T[];
  /** The song the player holds and where it stands; null with nothing queued. The card follows it (PAR-HOME-01). */
  now: HomeNowPlaying | null;
  /** Pauses or continues the song the player holds, for the card's Pause and Resume while its album is queued. */
  onToggle: () => void;
  labels: ParrotHomeLabels;
  /** The card's line under the title: artist, year, song count. */
  albumDetail: (album: A) => string;
  /**
   * A hook giving the card's large cover; the web player resolves it from its sealed store, the desktop from a URL.
   * null: no cover (the drawn picture); undefined: still on its way (a shimmer, PAR-META-20).
   */
  useJumpCover: (album: A | null) => string | null | undefined;
  /** An album tile of the "Recently added" and "Recently played" rows with its small cover. */
  albumTile: (album: A) => ReactNode;
  /** An artist's Play and "..." menu in "Your artists" (PAR-CARD-01). */
  artistControls?: (artist: R) => ParrotCardControls;
  /** An artist's small photo (PAR-META-15); the drawn picture when absent. */
  artistSrc?: (artist: R) => string | null | undefined;
  /** PAR-UP-07: whether an import is still fetching the artist's photo. */
  artistFetching?: (artist: R) => boolean;
  onOpenAlbum: (id: string) => void;
  onOpenArtist: (id: string) => void;
  /** Plays the album: from the history's song and position when there is one, else from its first song. */
  onPlayAlbum: (albumId: string, entry: HistoryAlbum | null, shuffle: boolean) => void;
  /** Opens the library's album or artist list; `sort` is the album order it opens in ("Recently added": "recent"). */
  onSeeAll: (view: "albums" | "artists", sort?: ParrotAlbumSort) => void;
};

/**
 * Home in the approved design (PAR-HOME-01), the same on the desktop and in the browser: "Jump back in" with the last
 * album played on this device, "Recently played", "Recently added" (the library's albums, newest added first; under
 * "Recently played" as on Badger's Home) and "Your artists". Played rows come from this device's own listening history (PAR-HOME-02) and every row from the
 * user's own library, never from suggestions (PAR-PROD-02). Nothing played yet: the card offers the library's first
 * album, said plainly ("Start listening").
 */
export function ParrotHome<A extends ParrotHomeAlbum, R extends { id: string; name: string }, T extends { id: string; title: string; albumId: string; durationMs: number | null }>(
  props: ParrotHomeProps<A, R, T>,
) {
  const { labels, now } = props;
  const { jump, played, albums, artists } = homeView(props.history, props.albums, props.artists, props.tracks);
  const button = jump ? homeJumpButton(jump.album.id, jump.entry, now) : null;
  const added = homeRecentlyAdded(props.albums);
  const waveTrack = button?.trackId ? props.tracks.find((track) => track.id === button.trackId) : undefined;
  const jumpCover = props.useJumpCover(jump?.album ?? null);
  return (
    <section className="space-y-10" data-testid="home">
      {/* UX-CRASH-01: a crashing row blanks only itself. */}
      {jump && button && (
        <RenderBoundary name="home-row:jump-back-in">
        <ParrotJumpBackIn
          album={jump.album}
          src={jumpCover}
          fetching={jumpCover === undefined}
          kicker={jump.entry ? labels.jumpBackIn : labels.startListening}
          detail={props.albumDetail(jump.album)}
          primaryLabel={button.kind === "pause" ? labels.pause : button.kind === "resume" ? labels.resume(formatDuration(button.positionMs)) : labels.play}
          primaryPauses={button.kind === "pause"}
          shuffleLabel={labels.shuffle}
          onPrimary={() => (button.live ? props.onToggle() : props.onPlayAlbum(jump.album.id, jump.entry, false))}
          onShuffle={() => props.onPlayAlbum(jump.album.id, null, true)}
          onOpen={() => props.onOpenAlbum(jump.album.id)}
          playing={button.live}
          animated={button.kind === "pause"}
          waveSeed={waveTrack?.id ?? jump.album.id}
          waveProgress={waveTrack?.durationMs ? Math.min(1, button.positionMs / waveTrack.durationMs) : 0}
          waveLabel={waveTrack?.title ?? jump.album.title}
        />
        </RenderBoundary>
      )}
      <ParrotShelf title={played ? labels.recentlyPlayed : labels.albums} seeAll={labels.seeAll} onSeeAll={() => props.onSeeAll("albums")} testId="home-recent">
        <RenderBoundary name="home-row:recent">
          <ParrotShelfRow>{albums.map((album) => props.albumTile(album))}</ParrotShelfRow>
        </RenderBoundary>
      </ParrotShelf>
      {added.length > 0 && (
        <ParrotShelf title={labels.recentlyAdded} seeAll={labels.seeAll} onSeeAll={() => props.onSeeAll("albums", "recent")} testId="home-added">
          <RenderBoundary name="home-row:added">
            <ParrotShelfRow>{added.map((album) => props.albumTile(album))}</ParrotShelfRow>
          </RenderBoundary>
        </ParrotShelf>
      )}
      <ParrotShelf title={labels.yourArtists} seeAll={labels.seeAll} onSeeAll={() => props.onSeeAll("artists")} testId="home-artists">
        <RenderBoundary name="home-row:artists">
          <ParrotShelfRow kind="artist">
            {artists.map((artist) => (
              <ParrotArtistCircle
                key={artist.id}
                id={artist.id}
                src={props.artistSrc?.(artist)}
                fetching={props.artistFetching?.(artist)}
                name={artist.name}
                onOpen={() => props.onOpenArtist(artist.id)}
                controls={props.artistControls?.(artist)}
              />
            ))}
          </ParrotShelfRow>
        </RenderBoundary>
      </ParrotShelf>
    </section>
  );
}

/** A page title of the account and settings pages (PAR-NAV-01). */
export function ParrotPageTitle({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <h1 className="mb-6 font-['Space_Grotesk'] text-4xl font-bold tracking-tight" data-testid={testId}>
      {children}
    </h1>
  );
}

/** One row of the account and settings pages: what it is, a line on what it does, and its control. */
export function ParrotSettingsRow({ title, body, children, testId }: { title: string; body: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#30363d] py-5 last:border-b-0" data-testid={testId}>
      {/* The text takes the free width and wraps, so a long description keeps the control beside it; the control
          moves under the text only on a narrow window. */}
      <div className="min-w-0 flex-1 basis-64">
        <div className="font-semibold">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
      {children}
    </div>
  );
}
