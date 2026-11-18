import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocalArtwork, useMediaSession } from "@space/media-session/react";
import {
  advance,
  currentEntry,
  goBack,
  HISTORY_POSITION_EVERY_MS,
  nextRepeatMode,
  parrotAlbumLoudness,
  parrotEvenVolumeLimits,
  parrotLoudnessMode,
  parrotPlaybackGainDb,
  setRepeat,
  setShuffle,
  type PlayQueue,
} from "@space/parrot-core";
import { GaplessEngine, type GaplessContext, type GaplessElement, type GaplessLimiter } from "@space/parrot-core/gapless";
import { effectiveVolume, usePersistedVolume, VolumeControl } from "@space/ui";
import { ParrotPlayerBar } from "@space/ui/parrot/screens";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { ParrotDesktopAlbum } from "../../shared/ipc";
import { coverArtwork } from "./coverArtwork";
import { useEvenVolume } from "./evenVolume";
import limiterWorkletUrl from "./limiterWorklet?worker&url";
import { measureDecodedLoudness, useMeasuredLoudness, withMeasuredLoudness } from "./loudness";
import type { Translate } from "./i18n";

/** Ten seconds of silence (8 kHz, 8-bit mono WAV) for the media session's anchor element: long enough for Chromium to treat it as a real player. */
const SILENT_WAV_URL = (() => {
  const samples = 8000 * 10;
  const bytes = new Uint8Array(44 + samples).fill(0x80, 44);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })) : "";
})();

/** The limiter of "Even out volume" at Loud (`./limiterWorklet`) on the player's output. */
const createLimiter = async (ctx: GaplessContext): Promise<GaplessLimiter> => {
  const context = ctx as unknown as AudioContext;
  await context.audioWorklet.addModule(limiterWorkletUrl);
  const node = new AudioWorkletNode(context, "parrot-limiter", { outputChannelCount: [2] });
  return Object.assign(node as unknown as GaplessLimiter, { setLimiting: (on: boolean) => node.port.postMessage({ limiting: on }) });
};

type PlayerProps = {
  t: Translate;
  /** The signed-in account: "Even out volume" is kept per account. */
  userId: string;
  queue: PlayQueue<ParrotLibraryTrack>;
  onQueue: (queue: PlayQueue<ParrotLibraryTrack>) => void;
  onPlaying: (playing: boolean) => void;
  /** Where to start the entry with this key, once its file is loaded ("Resume 1:18"). */
  startAt: { key: number; ms: number } | null;
  /** How far the playing song got: written to the listening history now and then and on pause. */
  onPosition: (track: ParrotLibraryTrack, ms: number) => void;
  /** The album's own pictures (PAR-META-04): `coverThumbUrl` for the bar, `coverUrl` for the media panel; null = drawn. */
  coverFor: (albumId: string) => Pick<ParrotDesktopAlbum, "coverUrl" | "coverThumbUrl"> | undefined;
  /** PAR-META-20: the album's cover is still on its way: the bar's cover shimmers. */
  coverFetching?: (albumId: string) => boolean;
  onOpen: (tab: "lyrics" | "queue" | null) => void;
  /** The playing song's artist or album name was clicked (PAR-NAV-05). */
  onOpenArtist?: (id: string) => void;
  onOpenAlbum?: (id: string) => void;
  openTab: "lyrics" | "queue" | null;
  like?: (track: ParrotLibraryTrack) => ReactNode;
  /** The playing song's time, for the synced lyrics (PAR-LYR-01). */
  onClock?: (ms: number) => void;
  /** Filled with a seek the now-playing page uses when a lyrics line is clicked. */
  seekRef?: { current: ((ms: number) => void) | null };
  /** Filled with the bar's play/pause, for Home's card: Pause while its album plays, Resume once paused (PAR-HOME-01). */
  toggleRef?: { current: (() => void) | null };
};

/**
 * The in-app player (PAR-PLAY-01) behind the bottom bar of the approved design (PAR-LOOK-01): it plays the queue's
 * current song through the local playback server and drives the shared `ParrotPlayerBar`, shuffle and repeat included.
 */
export default function Player({ t, userId, queue, onQueue, onPlaying, startAt, onPosition, coverFor, coverFetching, onOpen, onOpenArtist, onOpenAlbum, openTab, like, onClock, seekRef, toggleRef }: PlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  const lastSaved = useRef(0);
  const entry = currentEntry(queue);
  const track = entry?.track;
  // The player's own level, remembered on this computer (PAR-PLAY-05). It scales the output only, on top of each
  // song's even-volume gain (PAR-PLAY-03), and changes at once.
  const volume = usePersistedVolume("parrot.player.volume");
  // The engine's callbacks read the latest props through this, since the engine outlives renders.
  const latest = useRef({ queue, onQueue, onPosition, onClock, track });
  latest.current = { queue, onQueue, onPosition, onClock, track };

  // PAR-PLAY-03 item 1: songs play gaplessly through the shared Web Audio engine.
  const engineRef = useRef<GaplessEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new GaplessEngine({
      createContext: () => new AudioContext({ latencyHint: "playback" }) as unknown as GaplessContext,
      createLimiter,
      createElement: () => new Audio() as unknown as GaplessElement,
      fetchBytes: async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      },
      events: {
        onPlaying: setPlaying,
        onTime: (seconds) => {
          setPosition(seconds);
          const { track: playingTrack, onClock: clock, onPosition: save } = latest.current;
          const ms = seconds * 1000;
          clock?.(ms);
          if (playingTrack && Math.abs(ms - lastSaved.current) >= HISTORY_POSITION_EVERY_MS) {
            lastSaved.current = ms;
            save(playingTrack, ms);
          }
        },
        onDuration: setDuration,
        onAdvance: (key) => {
          // The next song already sounds, joined to the last one: the queue follows it.
          lastSaved.current = 0;
          const following = advance(latest.current.queue, "ended");
          if (following && following !== latest.current.queue && currentEntry(following)?.key === key) latest.current.onQueue(following);
        },
        onEnd: () => next("ended"),
        onError: () => setError(true),
        onDecoded: (key, buffer) => {
          // A song with no loudness yet is measured from this decode and evened from now on (PAR-PLAY-03 item 2).
          const decodedTrack = latest.current.queue.entries.find((queued) => queued.key === key)?.track;
          if (decodedTrack && withMeasuredLoudness(decodedTrack).gainDb === null) measureDecodedLoudness(decodedTrack.id, buffer as unknown as AudioBuffer);
        },
        log: (line) => console.info(line),
      },
    });
  }
  const engine = engineRef.current;

  // ACCT-STREAM-01..04: a song asks main for one of the profile's streams before it loads (main skips the question for
  // a song kept on this computer and reuses a place it already holds). Cancel at "Already playing on {device}. Play
  // here instead?" closes the player; another device taking the place over pauses it, and playing again asks again.
  const holdsStream = useRef(false);
  const giveStreamBack = () => {
    if (!holdsStream.current) return;
    holdsStream.current = false;
    void window.parrot.streamRelease();
  };
  const closePlayer = () => {
    engine.stop();
    setPlaying(false);
    const { queue: now, onQueue: setQueue } = latest.current;
    setQueue({ ...now, entries: [], queued: [], position: -1 });
  };
  /** True once this song may play; false (the player closed) when the user chose Cancel. */
  const askStream = async (song: ParrotLibraryTrack): Promise<boolean> => {
    const answer = await window.parrot.streamAcquire(song.id);
    console.info(`[stream] acquire ${JSON.stringify({ trackId: song.id, answer })}`);
    if (answer === "cancel") {
      closePlayer();
      return false;
    }
    holdsStream.current = true;
    return true;
  };
  useEffect(
    () =>
      window.parrot.onStreamState((state) => {
        if (state.kind !== "takenOver") return;
        console.info(`[stream] taken over ${JSON.stringify(state.device)}`);
        holdsStream.current = false;
        engine.pause();
      }),
    [engine]
  );
  useEffect(
    () => () => {
      engine.stop();
      giveStreamBack();
    },
    [engine]
  );
  const play = async () => {
    if (!holdsStream.current && track && !(await askStream(track))) return;
    engine.play();
  };

  // PAR-PLAY-03 item 2: songs play as recorded unless "Even out volume" is on. On, each song is brought to the level
  // picked: a whole album in order plays at its album value, keeping its own loud and quiet songs; shuffle or a mixed
  // queue plays every song at its track value. Loud lifts past the peaks, so the limiter runs.
  useMeasuredLoudness();
  const evenVolume = useEvenVolume(userId);
  const loudnessMode = parrotLoudnessMode(queue);
  const albumLoudness = parrotAlbumLoudness(queue.entries.map((queued) => withMeasuredLoudness(queued.track)));
  const gainFor = (song: ParrotLibraryTrack) => parrotPlaybackGainDb(withMeasuredLoudness(song), loudnessMode, albumLoudness, evenVolume);
  const currentGain = track ? gainFor(track) : 0;
  const limiting = parrotEvenVolumeLimits(evenVolume);
  useEffect(() => {
    engine.setLimiting(limiting);
  }, [limiting, engine]);
  useEffect(() => {
    engine.setCurrentGain(currentGain);
  }, [currentGain, engine]);

  useEffect(() => {
    if (!seekRef) return;
    seekRef.current = (ms) => engine.seek(ms / 1000);
    return () => {
      seekRef.current = null;
    };
  }, [seekRef, engine]);

  useEffect(() => {
    onPlaying(playing);
  }, [playing, onPlaying]);

  useEffect(() => {
    engine.setVolume(effectiveVolume(volume));
  }, [volume.volume, volume.muted, engine]);

  // Chromium keeps the system media session (MPRIS / SMTC / Now Playing) only around a media element: Web Audio alone
  // drops it the moment it pauses, and a media key could not resume. A silent looping element plays and pauses with the
  // engine so the session stays while paused, and lets go when no song is left (PLAY-OSMEDIA-01).
  const anchor = useRef<HTMLAudioElement | null>(null);
  const hasTrack = !!track;
  useEffect(() => {
    if (!anchor.current) anchor.current = Object.assign(new Audio(), { loop: true });
    const element = anchor.current;
    if (!hasTrack) {
      element.pause();
      element.removeAttribute("src");
      element.load();
      giveStreamBack();
      return;
    }
    if (!element.getAttribute("src")) element.src = SILENT_WAV_URL;
    if (playing) element.play().catch(() => undefined);
    else element.pause();
  }, [playing, hasTrack]);
  useEffect(() => () => anchor.current?.pause(), []);

  // A new entry (not only a new song: repeat-one replays the same entry) loads its file and plays, unless the engine
  // already moved onto it gaplessly.
  useEffect(() => {
    if (!track?.fileId || !entry) return;
    const song = track;
    const fileId = track.fileId;
    if (engine.currentKey === entry.key) {
      // Joined gaplessly: a streamed song after a kept one still needs its place (main answers at once when held).
      void askStream(song);
      return;
    }
    let cancelled = false;
    setError(false);
    setPosition(0);
    lastSaved.current = 0;
    void (async () => {
      if (!(await askStream(song))) return;
      const url = await window.parrot.playbackUrl(fileId);
      if (cancelled) return;
      const from = startAt && startAt.key === entry.key ? startAt.ms : 0;
      engine.load({ key: entry.key, url, durationMs: song.durationMs, gainDb: gainFor(song) }, from);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry?.key, track?.id]);

  // The song after this one (repeat one: this one again) is decoded ahead so it joins with no gap.
  const following = advance(queue, "ended");
  const nextEntry = following ? currentEntry(following) : null;
  const nextFileId = nextEntry?.track.fileId ?? null;
  const nextGain = nextEntry ? gainFor(nextEntry.track) : 0;
  useEffect(() => {
    if (!nextEntry || !nextFileId) {
      engine.setNext(null);
      return;
    }
    let cancelled = false;
    void window.parrot.playbackUrl(nextFileId).then((url) => {
      if (!cancelled) engine.setNext({ key: nextEntry.key, url, durationMs: nextEntry.track.durationMs, gainDb: nextGain });
    });
    return () => {
      cancelled = true;
    };
  }, [nextEntry?.key, nextFileId, entry?.key, nextGain]);

  const next = (reason: "ended" | "skip") => {
    const { queue: now, onQueue: setQueue } = latest.current;
    const after = advance(now, reason);
    if (!after) {
      engine.pause();
      // The queue is over: the place goes back; playing again asks again.
      giveStreamBack();
      return;
    }
    if (after === now) {
      // Repeat one: the same entry again, from the start.
      engine.seek(0);
      engine.play();
      return;
    }
    setQueue(after);
  };
  const previous = () => {
    // Like every player: past the first seconds, "previous" goes back to the start of the song.
    if (engine.position() > 3) engine.seek(0);
    else onQueue(goBack(queue));
  };
  const canNext = queue.position + 1 < queue.entries.length || queue.repeat === "all";
  const canPrevious = queue.position > 0 || queue.repeat === "all" || position > 3;

  // The panel shows the large cover, read into a blob: picture the window holds (PLAY-OSMEDIA-01 item 2).
  const artworkUrl = useLocalArtwork(track ? coverFor(track.albumId)?.coverUrl : null, coverArtwork);

  // PLAY-OSMEDIA-01: media keys, headset buttons and the OS panel (MPRIS / SMTC / Now Playing via Chromium) drive this
  // player. Paused keeps the session so a key can resume; no song (stopped) releases it.
  useMediaSession(
    {
      status: !track ? "none" : playing ? "playing" : "paused",
      info: track ? { title: track.title, artist: track.artistName, album: track.albumTitle, ...(artworkUrl ? { artworkUrl } : {}) } : null,
      positionS: position,
      durationS: Number.isFinite(duration) && duration > 0 ? duration : track?.durationMs ? track.durationMs / 1000 : undefined,
      rate: 1,
      canNext,
      canPrevious,
      canSeek: !error,
    },
    {
      play: () => void play(),
      pause: () => {
        engine.pause();
        if (track) onPosition(track, engine.position() * 1000);
      },
      stop: () => {
        engine.stop();
        setPlaying(false);
        giveStreamBack();
        onQueue({ ...queue, entries: [], queued: [], position: -1 });
      },
      next: () => next("skip"),
      previous,
      seekTo: (seconds) => engine.seek(seconds),
    }
  );

  const toggle = () => {
    if (playing) {
      engine.pause();
      if (track) onPosition(track, engine.position() * 1000);
    } else void play();
  };
  // The toggle reads this render's state, so the ref is refilled after every render.
  useEffect(() => {
    if (!toggleRef) return;
    toggleRef.current = toggle;
    return () => {
      toggleRef.current = null;
    };
  });
  // The engine plays through Web Audio, outside the page. This hidden marker carries no sound: it answers the
  // media-element questions tests ask (currentTime, paused, volume) from the engine.
  const marker = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || "currentTime" in node) return;
      Object.defineProperties(node, {
        currentTime: { get: () => engine.position(), set: (seconds: number) => engine.seek(seconds) },
        paused: { get: () => !engine.playing },
        volume: { get: () => engine.outputVolume, set: (level: number) => engine.setVolume(level) },
        muted: { get: () => engine.outputVolume === 0, set: (muted: boolean) => muted && engine.setVolume(0) },
      });
    },
    [engine]
  );
  const element = <span hidden ref={marker} data-testid="player-audio" />;
  if (!track || !entry) return element;
  const durationMs = Number.isFinite(duration) && duration > 0 ? duration * 1000 : (track.durationMs ?? 0);
  return (
    <>
      {element}
      <ParrotPlayerBar
        track={track}
        coverSrc={coverFor(track.albumId)?.coverThumbUrl}
        coverFetching={coverFetching?.(track.albumId)}
        playing={playing}
        positionMs={position * 1000}
        durationMs={durationMs}
        error={error}
        shuffle={queue.shuffle}
        repeat={queue.repeat}
        canPrevious={canPrevious}
        canNext={canNext}
        labels={{
          play: t("player.play"),
          pause: t("player.pause"),
          previous: t("player.previous"),
          next: t("player.next"),
          shuffle: t("player.shuffle"),
          repeatOff: t("player.repeatOff"),
          repeatAll: t("player.repeatAll"),
          repeatOne: t("player.repeatOne"),
          seek: t("player.seek"),
          lyrics: t("player.lyrics"),
          queue: t("player.queue"),
          openNowPlaying: t("player.openNowPlaying"),
          error: t("player.error"),
        }}
        onToggle={toggle}
        onPrevious={previous}
        onNext={() => next("skip")}
        onShuffle={() => onQueue(setShuffle(queue, !queue.shuffle))}
        onRepeat={() => onQueue(setRepeat(queue, nextRepeatMode(queue.repeat)))}
        onSeek={(fraction) => {
          if (durationMs) engine.seek((fraction * durationMs) / 1000);
        }}
        onOpen={onOpen}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        openTab={openTab}
        like={like?.(track)}
        volume={
          <VolumeControl
            volume={volume.volume}
            muted={volume.muted}
            onVolumeChange={volume.setVolume}
            onToggleMute={volume.toggleMute}
            labels={{ volume: t("player.volume"), mute: t("player.mute"), unmute: t("player.unmute") }}
            testId="player-volume"
          />
        }
      />
    </>
  );
}
