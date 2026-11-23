// Starting a song: the album's tracks are registered with the loopback media proxy (which fetches and decrypts only
// the 1 MiB chunks a byte range covers, PAR-FMT-01) and queued in the Media3 player service (PAR-PLAY-01/03), each
// with its album's large cover as a picture kept on the phone for the notification and lock-screen card
// (PLAY-OSMEDIA-01: a local file:// address, never sent anywhere). A song kept on the phone (PAR-OFFL-02) plays its
// kept copy, which the proxy reads from the phone's disk first; with no connection the proxy reads only the disk, and
// only the kept songs are queued.
//
// Which copy a song plays (PAR-PLAY-02, PAR-PLAY-04): the shared picker (`createParrotCopyPicker`) is fed every chunk the
// proxy downloads for the player. The song started now gets its copy as it starts; every other queued song is
// registered with the copy the speed gives at that moment, and its copy is settled when the song before it starts, so
// the gapless player readies the right one. Once the player has asked for a song, its copy never changes. Kept songs
// always play their kept original.
import { listProfiles } from "@space/shared/api";
import { mainProfileId } from "@space/shared/profiles";
import { MediaProxy, resolveGatewayCandidates } from "@space/mobile-media-proxy";
import { AudioPlayback, type AudioQueueInsert, type AudioQueueItem } from "@space/mobile-audio-playback";
import {
  createParrotCopyPicker,
  parrotEvenVolumeLimits,
  parrotQueueGainsDb,
  notYetQueued,
  pickPlayableFile,
  type ParrotCoverKeys,
  type TrackFileRow,
  type TrackRow,
} from "@space/parrot-core";
import { chunkedFile, coverUri, keptCoverUri, trackFiles } from "./library";
import { keptFileIdFor } from "./kept";
import { activeProfileId } from "./activeProfile";
import { acquireStream, releaseStream } from "./streamSlot";
import { noteHelloPlay } from "@space/shared/dailyHello";
import { getEvenVolume, subscribeEvenVolume } from "./evenVolume";

let profileIdCache: { token: string; profileId: string } | null = null;

/** Which copy each song plays, from how fast the proxy downloaded the chunks of the songs before it. */
const copyPicker = createParrotCopyPicker((line) => console.log(line));

/** Queued songs whose copy is still open (not kept): their files and the one registered, by queue key. */
const openCopies = new Map<string, { files: TrackFileRow[]; durationMs: number | null; fileId: string }>();
let queueKeyCounter = 0;
let stopWatchingCopies: (() => void) | null = null;

/** Puts `file` behind queue entry `key`; the proxy refuses once the player has started reading that entry. Settles when done. */
const swapCopy = (key: string, open: { fileId: string }, file: TrackFileRow, step: "next" | "ahead"): Promise<void> => {
  const previous = open.fileId;
  open.fileId = file.id;
  return chunkedFile(file)
    .then((layout) => MediaProxy.swapChunkedFile({ ...layout, id: key }))
    .then((swapped) => {
      if (!swapped) open.fileId = previous;
      console.log(`parrot.copy.${step}`, JSON.stringify({ key, fileId: file.id, lightCopy: file.lightCopy, swapped }));
    })
    .catch((error) => {
      open.fileId = previous;
      console.log(`parrot.copy.${step}_failed`, JSON.stringify({ key, message: error instanceof Error ? error.message : String(error) }));
    });
};

/**
 * Each time a song starts: settles the next song's copy for good, and brings every song further ahead to the copy the
 * measured speed gives now, since the player may read ahead more than one song (short songs, light copies). When what
 * Next plays changes midway (shuffle, repeat, a queue edit), that song's copy is settled then. Once the next copy is
 * settled, the proxy is told the songs Next and Previous go to, so it loads their openings while the player is idle
 * (PAR-PLAY-07). Feeds the picker every download. Installed once per proxy.
 */
const watchCopies = () => {
  if (stopWatchingCopies) return;
  const downloads = MediaProxy.onDownload(({ bytes, ms }) => copyPicker.record(bytes, ms));
  let playingKey: string | null = null;
  let neighbours = "";
  const states = AudioPlayback.onState((state) => {
    if (!state.key) return;
    const started = state.key !== playingKey;
    if (started) {
      playingKey = state.key;
      openCopies.delete(state.key);
    }
    const nextKey = state.nextKey ?? null;
    const previousKey = state.previousKey ?? null;
    const triple = JSON.stringify([state.key, nextKey, previousKey]);
    if (!started && triple === neighbours) return;
    neighbours = triple;
    const next = nextKey ? openCopies.get(nextKey) : undefined;
    let settled: Promise<void> = Promise.resolve();
    if (nextKey && next) {
      openCopies.delete(nextKey);
      const file = copyPicker.pick(next.files, next.durationMs);
      if (file && file.id !== next.fileId) settled = swapCopy(nextKey, next, file, "next");
    }
    if (started) {
      for (const [key, ahead] of openCopies) {
        const file = copyPicker.peek(ahead.files, ahead.durationMs);
        if (file && file.id !== ahead.fileId) void swapCopy(key, ahead, file, "ahead");
      }
    }
    const current = state.key;
    void settled.then(() => {
      // A later state already named other neighbours: that one tells the proxy.
      if (neighbours !== triple) return;
      console.log("parrot.preload.neighbours", JSON.stringify({ current, next: nextKey, previous: previousKey }));
      return MediaProxy.setNeighbours({ current, next: nextKey, previous: previousKey }).then(
        (running) => {
          if (!running) console.log("parrot.preload.neighbours_skipped", JSON.stringify({ reason: "proxy_not_running" }));
        },
        (error) =>
          console.log("parrot.preload.neighbours_failed", JSON.stringify({ message: error instanceof Error ? error.message : String(error) })),
      );
    });
  });
  stopWatchingCopies = () => {
    downloads();
    states.remove();
  };
};

/**
 * Playback sessions name the profile they play for (STOR-BW-11): the one picked in "Who's listening?" (ACCT-PROF-01),
 * else, before the first profile list arrived, the account's main profile.
 */
const sessionProfileId = async (token: string) => {
  const active = activeProfileId();
  if (active) return active;
  if (profileIdCache?.token === token) return profileIdCache.profileId;
  const main = mainProfileId((await listProfiles(token)).profiles);
  if (!main) throw new Error("PROFILE_MISSING");
  profileIdCache = { token, profileId: main };
  return main;
};

/** Starts the proxy; "offline" when the account cannot be reached, so only kept songs can play. */
const ensureProxy = async (token: string, libraryKey: string): Promise<"online" | "offline"> => {
  let online: { profileId: string; gatewayBaseUrls: string[] };
  try {
    online = { profileId: await sessionProfileId(token), gatewayBaseUrls: await resolveGatewayCandidates(token, null) };
  } catch (error) {
    console.log("parrot.playback.offline", JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    await MediaProxy.start({ libraryKeyBase64: libraryKey, config: { clientKind: "offline" } });
    return "offline";
  }
  await MediaProxy.start({
    libraryKeyBase64: libraryKey,
    config: { clientKind: "storage-tunnel", gatewayBaseUrls: online.gatewayBaseUrls, authToken: token, appId: "parrot", profileId: online.profileId },
  });
  watchCopies();
  // The same config reuses the running proxy; another one (a new token) rebuilds it on a new port and forgets its
  // files, so every play registers its queue again.
  return "online";
};

type QueueTrack = TrackRow & { albumTitle?: string; cover?: ParrotCoverKeys | null };

// Even out volume (PAR-PLAY-03 item 2): the songs of the player's queue, so their gains follow shuffle, additions and
// the setting. Off (the default) every gain is 0 dB: songs play as recorded.
let queuedTracks: QueueTrack[] = [];
let queueMixed = false;
let queueShuffled = false;
const queueGains = (shuffle: boolean) => parrotQueueGainsDb(queuedTracks, shuffle || queueMixed, getEvenVolume());

/** Applies the setting to the playing queue at once: its gains, and the limiter that Loud needs. */
const applyEvenVolume = async () => {
  await AudioPlayback.setLimiting(parrotEvenVolumeLimits(getEvenVolume())).catch(() => undefined);
  if (queuedTracks.length) await AudioPlayback.setGains(queueGains(queueShuffled)).catch(() => undefined);
};
subscribeEvenVolume(() => void applyEvenVolume());

/**
 * The player items of `tracks` (tracks without a stored file, or not kept while offline, are left out) and where
 * `tracks[startIndex]` landed among them. The started song's large cover is fetched (alongside the proxy start) so the
 * lock-screen card shows it; the other songs carry theirs when it is already kept on the phone. `playsNow`: the song at
 * `startIndex` starts now, so its copy is picked for good. `streamed`: a queued song comes from the account rather
 * than the phone, so it takes one of the profile's streams (ACCT-STREAM-01/03).
 */
const queueItems = async (input: {
  token: string;
  libraryKey: string;
  albumTitle?: string;
  tracks: QueueTrack[];
  startIndex: number;
  playsNow: boolean;
  gains: Record<string, number>;
}) => {
  const { gains } = input;
  const startCover = input.tracks[input.startIndex]?.cover?.coverObjectKey ?? null;
  const startArtwork = coverUri(startCover);
  const mode = await ensureProxy(input.token, input.libraryKey);
  const items: AudioQueueItem[] = [];
  let start = 0;
  let streamed = false;
  for (const [index, track] of input.tracks.entries()) {
    const keptFileId = keptFileIdFor(track.id);
    if (mode === "offline" && !keptFileId) continue;
    const files = await trackFiles(track.id);
    const kept = keptFileId ? (files.find((file) => file.id === keptFileId) ?? null) : null;
    const file =
      kept ??
      (mode === "offline"
        ? pickPlayableFile(files)
        : input.playsNow && index === input.startIndex
          ? copyPicker.pick(files, track.durationMs)
          : copyPicker.peek(files, track.durationMs));
    if (!file) continue;
    if (index === input.startIndex) start = items.length;
    if (mode === "online" && !keptFileId) streamed = true;
    // Each queue entry has its own key, so its copy can be settled before it plays without touching the others.
    const key = `${track.id}~${++queueKeyCounter}`;
    const url = await MediaProxy.registerChunkedFile({ ...(await chunkedFile(file)), id: key });
    if (!kept && mode === "online" && !(input.playsNow && index === input.startIndex)) {
      openCopies.set(key, { files, durationMs: track.durationMs, fileId: file.id });
    }
    const coverKey = track.cover?.coverObjectKey ?? null;
    const artworkUri = coverKey && coverKey === startCover ? await startArtwork : keptCoverUri(coverKey);
    // No mime type: the copy behind the key may still change format (FLAC original, Ogg Opus light copy); the player
    // reads it from the file.
    items.push({
      gainDb: gains[track.id] ?? 0,
      id: track.id,
      key,
      url,
      title: track.title,
      artist: track.artistName || undefined,
      album: track.albumTitle ?? input.albumTitle,
      artworkUri: artworkUri ?? undefined,
    });
  }
  if (items.length === 0) throw new Error("NO_PLAYABLE_FILE");
  return { items, start, streamed };
};

/**
 * Streamed songs ask for one of the profile's streams first (ACCT-STREAM-02). Cancel at "Already playing on {device}.
 * Play here instead?" forgets the entries just registered and throws `STREAM_CANCELLED` before the player is touched,
 * so the music stays as it was.
 */
const ensureStream = async (token: string, streamed: boolean, items: AudioQueueItem[]) => {
  if ((await acquireStream({ token, streamed })) !== "cancel") {
    // OPS-BIZ-20: one play for the daily hello's tally (streamed or kept).
    noteHelloPlay();
    return;
  }
  for (const item of items) if (item.key) openCopies.delete(item.key);
  throw new Error("STREAM_CANCELLED");
};

/** Plays `tracks[startIndex]`, then the rest of the list. */
export const playTracks = async (input: {
  token: string;
  libraryKey: string;
  /** The album the list comes from; a list of songs from several albums gives each song its own `albumTitle`. */
  albumTitle?: string;
  tracks: QueueTrack[];
  startIndex: number;
  /** Where the first song starts (Home's "Resume", PAR-HOME-01); 0 by default. */
  startPositionMs?: number;
  /** Plays the list in a random order (Home's "Shuffle"); otherwise in order, shuffle off. */
  shuffle?: boolean;
}) => {
  const shuffled = Boolean(input.shuffle);
  const previousKeys = [...openCopies.keys()];
  const gains = parrotQueueGainsDb(input.tracks, shuffled, getEvenVolume());
  const { items, start, streamed } = await queueItems({ ...input, playsNow: true, gains });
  await ensureStream(input.token, streamed, items);
  queuedTracks = input.tracks;
  queueMixed = false;
  queueShuffled = shuffled;
  await AudioPlayback.setLimiting(parrotEvenVolumeLimits(getEvenVolume())).catch(() => undefined);
  // The new list replaces the queue: the songs of the old one never play.
  for (const key of previousKeys) openCopies.delete(key);
  const state = await AudioPlayback.setQueue(items, start, input.startPositionMs ?? 0);
  return AudioPlayback.setShuffle(Boolean(input.shuffle)).catch(() => state);
};

/**
 * Adds `tracks` to the queue without stopping the song playing (PAR-CARD-01): "next" right after it (Play next), "end"
 * after the last song (Add to queue). A song is in Up next at most once (PAR-CARD-02): the songs the player is playing
 * or holds up next are left out. Resolves to how many songs were added; 0 means they were all there already.
 */
export const queueTracks = async (input: { token: string; libraryKey: string; albumTitle?: string; tracks: QueueTrack[]; where: AudioQueueInsert }) => {
  const [now, upNext] = await Promise.all([AudioPlayback.getState(), AudioPlayback.getUpNext()]);
  const fresh = notYetQueued([now.mediaId, ...upNext], input.tracks, (track) => track.id);
  console.log("parrot.queue.add", JSON.stringify({ where: input.where, asked: input.tracks.length, added: fresh.length, playing: now.mediaId, upNext: upNext.length }));
  if (fresh.length === 0) return 0;
  // A queue with songs added is no longer one album in order: every song plays at its track value.
  const tracks = [...queuedTracks, ...fresh];
  const gains = parrotQueueGainsDb(tracks, true, getEvenVolume());
  const { items, streamed } = await queueItems({ ...input, tracks: fresh, startIndex: 0, playsNow: false, gains });
  await ensureStream(input.token, streamed, items);
  queuedTracks = tracks;
  queueMixed = true;
  await AudioPlayback.addItems(items, input.where);
  await AudioPlayback.setGains(gains).catch(() => undefined);
  return fresh.length;
};

/** Shuffle on or off (the player screen): an album in order switches between album and track values with it. */
export const setPlaybackShuffle = async (enabled: boolean) => {
  const state = await AudioPlayback.setShuffle(enabled);
  queueShuffled = enabled;
  await AudioPlayback.setGains(queueGains(enabled)).catch(() => undefined);
  return state;
};

/** Sign out: stop the music and the proxy, give the stream back, and forget the measured speed. */
export const stopPlayback = async () => {
  await AudioPlayback.stop().catch(() => undefined);
  await releaseStream().catch(() => undefined);
  await MediaProxy.stop().catch(() => undefined);
  stopWatchingCopies?.();
  stopWatchingCopies = null;
  openCopies.clear();
  copyPicker.reset();
  profileIdCache = null;
  queuedTracks = [];
  queueShuffled = false;
};
