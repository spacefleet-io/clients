/**
 * Skip detection from stored signatures (META-SKIP-04, Chris 2026-11-24).
 *
 * Each video's signature (sound and picture of its first and last 10 minutes) is made at import inside the
 * seek-bar preview pass and stored, encrypted, next to its preview sheets (`previewSheets.skipSignature`), so it
 * reaches each user's vault with the library. Matching a show compares the signatures of its episodes (pooled
 * across seasons); it never reads a video. A signature this computer made is cached as it is recorded; one made on
 * another computer is downloaded once and cached (`media_skip_analysis`, kind `skip-signature-v1`).
 *
 * How the two sides combine, per episode:
 * - intro: sound finds the window, picture sets the exact edges. Both found and overlapping: the picture's edges,
 *   except where a picture edge lies more than 3 s inside the sound's (a title card that varies by episode), where
 *   the sound's edge is kept. Sure (confidence 1) only when both edges of sound and picture lie within 3 s of each
 *   other; an edge they disagree on (Parks and Recreation S2E03: the sound ends 8 s after the picture, 11 s before
 *   the real end) is not sure. Only one side found it, or the two apart: the sound's times (else the picture's), not
 *   sure (confidence 0.5: the player asks "Was it right?").
 * - credits: from the picture; sure when the sound found them within 5 s, else not sure. Credits are never skipped
 *   on their own (PLAY-SKIP-08): the player shows a button.
 * - films: nothing (Chris 2026-11-24): a film has no intro or credits markers.
 * A single episode of a show gets nothing (nothing to compare with).
 *
 * What a match writes, per episode and kind: the times as source `detected` through `mergeSkipMarkers`, which never
 * replaces the user's own times nor the metadata service's; the matched span (`skip-match-v1`, local), which the player's
 * "Change times" measures a fix against; and, where the user saved a fix for the season (`skip-fix-v1`), the fix
 * placed on the episode's own match. A match is idempotent: the same signatures write nothing new.
 *
 * Restart-safe (RT-LIFE-04): a show waiting for its match is kept on disk (`pendingPath`, fsync + rename) until the
 * match ends, and matched again at the next start. Matches of a runtime run one at a time. A signature that cannot be
 * downloaded (no connection) leaves the show pending: matched again on the next signature or the next start.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  SKIP_SIGNATURE_ANALYSIS_KIND,
  decodeSkipSignatureAsync,
  detectSkipPictureAsync,
  detectSkipSegmentsAsync,
  parseSkipSignature,
  skipEpisodeAudioFromPayload,
  skipEpisodePictureFromPayload,
  type SkipDetectResult,
  type SkipEpisodeAudio,
  type SkipEpisodePicture,
  type SkipPictureResult,
  type SkipSignature,
} from "@space/ingest-core/skipDetect";
import type { MediaDetails } from "@space/shared/libraryTypes";
import {
  SKIP_FIX_ANALYSIS_KIND,
  SKIP_MATCH_ANALYSIS_KIND,
  SKIP_SOURCE_DETECTED,
  SKIP_SOURCE_USER,
  placeSkipFix,
  readSkipFixPayload,
  readSkipMatchPayload,
  skipSourceRank,
  type SkipKind,
  type SkipMarkerWrite,
  type SkipMatchPayload,
} from "@space/shared/skipMarkers";

type AnalysisRow = { episodeId: string | null; kind: string; payload: Record<string, unknown> };

/** The library calls a match makes (`BadgerLibraryDbService`). */
export type SkipDetectLibrary = {
  call(method: string, args?: unknown[]): Promise<unknown>;
  runBatch<T>(label: string, fn: () => Promise<T>): Promise<T>;
};

/** The cached form of a signature: the object it was read from, so a remade signature is fetched again. */
export type CachedSkipSignature = { objectKey: string; signature: SkipSignature };

export type SkipMatchRunnerDeps = {
  libraryDb: SkipDetectLibrary;
  /** Downloads and decrypts a stored signature object (the signed-in user's token and library key); throws. */
  fetchSignature: (objectKey: string) => Promise<Uint8Array>;
  /** The file listing the shows waiting for their match (kept across restarts). */
  pendingPath: () => string;
  log?: (line: string) => void;
};

export type SkipMatchRunner = {
  /** Cache a signature this runtime just recorded (no download) and match its show. */
  signatureRecorded(input: { mediaId: string; episodeId: string | null; objectKey: string; signature: SkipSignature }): Promise<void>;
  /** Match a show again from its stored signatures. */
  match(mediaId: string): Promise<void>;
  /** At start: match every show left waiting by a stopped or crashed runtime. */
  resume(): Promise<void>;
  stop(): void;
};

const KINDS: SkipKind[] = ["intro", "credits"];

/** Detected times differing by less than this from the ones stored are not written again (no sync churn). */
const SAME_TIMES_SECONDS = 0.05;
/** A picture intro edge more than this inside the sound's keeps the sound's edge; edges this close agree (sure). */
const PICTURE_INSIDE_SECONDS = 3;
/** Sound and picture credits starts this close agree. */
const CREDITS_AGREE_SECONDS = 5;
/** Confidence of times the player asks about ("Was it right?"); sure times carry 1. */
export const SKIP_UNSURE_CONFIDENCE = 0.5;

export type CombinedSkip = { start: number; end: number; rawStart: number; rawEnd: number; confidence: number };

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** The intro of one episode from its sound and picture results (see the file comment). */
export const combineSkipIntro = (
  audio: SkipDetectResult | undefined,
  picture: SkipPictureResult["intro"] | undefined
): CombinedSkip | null => {
  const sound = audio?.found && audio.confident ? audio : null;
  const pic = picture && picture.support >= Math.min(2, picture.compared) ? picture : null;
  if (sound && pic) {
    const shorter = Math.min(sound.end - sound.start, pic.end - pic.start);
    if (shorter > 0 && overlap(sound, pic) >= shorter / 2) {
      const start = pic.start - sound.start > PICTURE_INSIDE_SECONDS ? sound.start : pic.start;
      const end = sound.end - pic.end > PICTURE_INSIDE_SECONDS ? sound.end : pic.end;
      const agree = Math.abs(pic.start - sound.start) <= PICTURE_INSIDE_SECONDS && Math.abs(pic.end - sound.end) <= PICTURE_INSIDE_SECONDS;
      return { start, end, rawStart: sound.rawStart, rawEnd: sound.rawEnd, confidence: agree ? 1 : SKIP_UNSURE_CONFIDENCE };
    }
  }
  if (sound) return { start: sound.start, end: sound.end, rawStart: sound.rawStart, rawEnd: sound.rawEnd, confidence: SKIP_UNSURE_CONFIDENCE };
  if (pic) return { start: pic.start, end: pic.end, rawStart: pic.start, rawEnd: pic.end, confidence: SKIP_UNSURE_CONFIDENCE };
  return null;
};

/** The credits of one episode: the picture's start, sure when the sound agrees; the sound's alone, not sure. */
export const combineSkipCredits = (
  audio: SkipDetectResult | undefined,
  pictureStart: number | null | undefined,
  durationSeconds: number
): CombinedSkip | null => {
  const sound = audio?.found && audio.confident ? audio : null;
  if (pictureStart != null && pictureStart < durationSeconds) {
    const agree = sound !== null && Math.abs(sound.start - pictureStart) <= CREDITS_AGREE_SECONDS;
    return {
      start: pictureStart,
      end: durationSeconds,
      rawStart: sound && agree ? sound.rawStart : pictureStart,
      rawEnd: sound && agree ? sound.rawEnd : durationSeconds,
      confidence: agree ? 1 : SKIP_UNSURE_CONFIDENCE,
    };
  }
  if (sound) return { start: sound.start, end: sound.end, rawStart: sound.rawStart, rawEnd: sound.rawEnd, confidence: SKIP_UNSURE_CONFIDENCE };
  return null;
};

/** Writes `content` to `path` all-or-nothing (temp file, fsync, rename). */
export const writeFileDurably = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

type PendingMatches = { version: 1; mediaIds: string[] };

export const createSkipMatchRunner = (deps: SkipMatchRunnerDeps): SkipMatchRunner => {
  const log = deps.log ?? ((line: string) => console.info(line));
  let stopped = false;
  /** Matches run one after another (each reads and writes the whole show). */
  let chain: Promise<void> = Promise.resolve();
  /** Shows with a match queued and not started: a second request joins it. */
  const queued = new Map<string, Promise<void>>();

  const readPendingIds = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(deps.pendingPath(), "utf8")) as Partial<PendingMatches>;
      return parsed.version === 1 && Array.isArray(parsed.mediaIds) ? parsed.mediaIds.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  /** In memory too: the file is only written from here (one runtime per library). */
  const pending = new Set<string>();
  let pendingLoaded = false;
  const loadPending = () => {
    if (pendingLoaded) return;
    pendingLoaded = true;
    for (const id of readPendingIds()) pending.add(id);
  };
  const savePending = () => writeFileDurably(deps.pendingPath(), JSON.stringify({ version: 1, mediaIds: [...pending] } satisfies PendingMatches));
  const markPending = (mediaId: string, on: boolean) => {
    loadPending();
    if (on === pending.has(mediaId)) return;
    if (on) pending.add(mediaId);
    else pending.delete(mediaId);
    try {
      savePending();
    } catch (err) {
      log(`[skip-detect] pending.write_failed ${JSON.stringify({ mediaId, error: err instanceof Error ? err.message : String(err) })}`);
    }
  };

  const listAnalysis = async (mediaId: string, kind?: string) =>
    ((await deps.libraryDb.call("listSkipAnalysis", kind ? [mediaId, kind] : [mediaId])) as AnalysisRow[] | null) ?? [];

  /** Per episode of the show: its stored signature's object key. */
  const signedVideos = (details: MediaDetails) => {
    const fileById = new Map(details.files.map((file) => [file.id, file]));
    const out = new Map<string | null, { objectKey: string; season: number; episode: number }>();
    const formats = [...details.formats].sort((a, b) => Number(b.isSource === true) - Number(a.isSource === true));
    for (const format of formats) {
      const objectKey = format.previewSheets?.skipSignature?.objectKey;
      const file = fileById.get(format.fileId);
      if (!objectKey || !file) continue;
      if (file.season == null || file.episode == null) continue;
      const episode = details.episodes.find((row) => row.seasonNumber === file.season && row.episodeNumber === file.episode);
      if (episode && !out.has(episode.id)) out.set(episode.id, { objectKey, season: file.season, episode: file.episode });
    }
    return out;
  };

  /** The show's signatures: cached ones, then downloads of the missing (cached as they come). */
  const loadSignatures = async (mediaId: string, details: MediaDetails) => {
    const videos = signedVideos(details);
    const cached = new Map<string | null, CachedSkipSignature>();
    for (const row of await listAnalysis(mediaId, SKIP_SIGNATURE_ANALYSIS_KIND)) {
      const raw = row.payload as Partial<CachedSkipSignature>;
      const signature = parseSkipSignature(raw.signature);
      if (signature && typeof raw.objectKey === "string") cached.set(row.episodeId, { objectKey: raw.objectKey, signature });
    }
    const signatures = new Map<string | null, { season: number; episode: number; signature: SkipSignature }>();
    let downloaded = 0;
    let unreadable = 0;
    for (const [episodeId, video] of videos) {
      const hit = cached.get(episodeId);
      if (hit && hit.objectKey === video.objectKey) {
        signatures.set(episodeId, { ...video, signature: hit.signature });
        continue;
      }
      // A failed download throws: the show stays pending for the next signature or start.
      const signature = await decodeSkipSignatureAsync(await deps.fetchSignature(video.objectKey));
      if (!signature) {
        unreadable++;
        continue;
      }
      await deps.libraryDb.call("upsertSkipAnalysis", [mediaId, episodeId, SKIP_SIGNATURE_ANALYSIS_KIND, { objectKey: video.objectKey, signature }]);
      signatures.set(episodeId, { ...video, signature });
      downloaded++;
    }
    return { signatures, downloaded, unreadable };
  };

  const matchShow = async (mediaId: string) => {
    const startedAt = Date.now();
    const details = (await deps.libraryDb.call("getMediaDetails", [mediaId])) as MediaDetails | null;
    if (!details) return;
    // Films have no intro or credits markers (Chris 2026-11-24).
    if (details.type === "movie") {
      log(`[skip-detect] show.skipped ${JSON.stringify({ mediaId, reason: "film" })}`);
      return;
    }
    const { signatures, downloaded, unreadable } = await loadSignatures(mediaId, details);
    const loadedAt = Date.now();
    const rows = await listAnalysis(mediaId);
    const matchRows = new Map<string | null, SkipMatchPayload | null>();
    let fixRow: unknown = null;
    for (const row of rows) {
      if (row.kind === SKIP_FIX_ANALYSIS_KIND && row.episodeId === null) fixRow = row.payload;
      if (row.kind === SKIP_MATCH_ANALYSIS_KIND) matchRows.set(row.episodeId, readSkipMatchPayload(row.payload));
    }

    type Found = { episodeId: string | null; season: number; episode: number; durationSeconds: number; skips: Partial<Record<SkipKind, CombinedSkip>> };
    const found: Found[] = [];
    const audio: SkipEpisodeAudio[] = [];
    const pictures: SkipEpisodePicture[] = [];
    for (const [episodeId, entry] of signatures) {
      if (!episodeId) continue;
      const ep = { id: episodeId, season: entry.season, episode: entry.episode };
      const a = entry.signature.audio ? skipEpisodeAudioFromPayload(ep, entry.signature.audio) : null;
      if (a) audio.push(a);
      const p = skipEpisodePictureFromPayload(ep, entry.signature.durationSeconds, entry.signature.picture);
      if (p) pictures.push(p);
    }
    if (signatures.size < 2) {
      log(`[skip-detect] show.waiting ${JSON.stringify({ mediaId, signatures: signatures.size, reason: "needs-two-episodes" })}`);
      return;
    }
    const sound: Record<SkipKind, Map<string, SkipDetectResult>> =
      audio.length >= 2
        ? { intro: await detectSkipSegmentsAsync(audio, "intro"), credits: await detectSkipSegmentsAsync(audio, "credits") }
        : { intro: new Map(), credits: new Map() };
    // Matching grows with the square of the show's episodes: it gives the event loop turns (MPV-PREV-07).
    const picture = pictures.length >= 2 ? await detectSkipPictureAsync(pictures) : new Map<string, SkipPictureResult>();
    for (const [episodeId, entry] of signatures) {
      if (!episodeId) continue;
      const duration = entry.signature.durationSeconds;
      const pic = picture.get(episodeId);
      const intro = combineSkipIntro(sound.intro.get(episodeId), pic?.intro) ?? undefined;
      const credits = combineSkipCredits(sound.credits.get(episodeId), pic?.credits, duration) ?? undefined;
      found.push({ episodeId, season: entry.season, episode: entry.episode, durationSeconds: duration, skips: { intro, credits } });
    }

    const fixes = readSkipFixPayload(fixRow);
    let written = 0;
    const summary: Record<SkipKind, { sure: number; unsure: number }> = { intro: { sure: 0, unsure: 0 }, credits: { sure: 0, unsure: 0 } };
    await deps.libraryDb.runBatch(`skip-detect:${mediaId}`, async () => {
      for (const ep of found) {
        const match: SkipMatchPayload = { version: 1, intro: null, credits: null };
        const markers: SkipMarkerWrite[] = [];
        for (const kind of KINDS) {
          const skip = ep.skips[kind];
          if (!skip) continue;
          summary[kind][skip.confidence >= 1 ? "sure" : "unsure"]++;
          match[kind] = { rawStart: round3(skip.rawStart), rawEnd: round3(skip.rawEnd) };
          const seasonFix = ep.episodeId ? fixes.seasons[String(ep.season)]?.[kind] : undefined;
          const placed =
            seasonFix && ep.episodeId && !fixes.episodeOnly[ep.episodeId]?.[kind]
              ? placeSkipFix(match[kind]!, seasonFix, ep.durationSeconds)
              : null;
          markers.push(
            placed
              ? { type: kind, ...placed, source: SKIP_SOURCE_USER }
              : { type: kind, startSeconds: round3(skip.start), endSeconds: round3(skip.end), source: SKIP_SOURCE_DETECTED, confidence: skip.confidence }
          );
        }
        if (JSON.stringify(matchRows.get(ep.episodeId) ?? null) !== JSON.stringify(match)) {
          await deps.libraryDb.call("upsertSkipAnalysis", [mediaId, ep.episodeId, SKIP_MATCH_ANALYSIS_KIND, match]);
        }
        const current = details.skipMarkers.filter((marker) => marker.episodeId === ep.episodeId);
        const changed: SkipMarkerWrite[] = [];
        // One line per episode and kind: which times the player has now, and what they replaced (no titles, no paths).
        for (const kind of KINDS) {
          const marker = markers.find((row) => row.type === kind) ?? null;
          const held = current.find((row) => row.type === kind) ?? null;
          const shownHeld = held ? { source: held.source, start: round3(held.startSeconds), end: round3(held.endSeconds) } : null;
          let outcome: "written" | "same" | "kept" | "not-found";
          if (!marker) outcome = "not-found";
          else if (held && skipSourceRank(held.source) > skipSourceRank(marker.source)) outcome = "kept";
          else if (
            held &&
            held.source === marker.source &&
            (held.confidence ?? null) === (marker.confidence ?? null) &&
            Math.abs(held.startSeconds - marker.startSeconds) < SAME_TIMES_SECONDS &&
            Math.abs(held.endSeconds - marker.endSeconds) < SAME_TIMES_SECONDS
          )
            outcome = "same";
          else {
            outcome = "written";
            changed.push(marker);
          }
          const now = outcome === "written" ? { source: marker!.source, start: marker!.startSeconds, end: marker!.endSeconds, confidence: marker!.confidence ?? null } : shownHeld;
          log(
            `[skip-detect] episode.marker ${JSON.stringify({ mediaId, episodeId: ep.episodeId, season: ep.season, episode: ep.episode, kind, outcome, now, replaced: outcome === "written" ? shownHeld : null })}`
          );
        }
        if (changed.length === 0) continue;
        await deps.libraryDb.call("mergeSkipMarkers", [mediaId, ep.episodeId, changed]);
        written++;
      }
    });
    log(
      `[skip-detect] show.matched ${JSON.stringify({ mediaId, signatures: signatures.size, downloaded, unreadable, intro: summary.intro, credits: summary.credits, episodesWritten: written, loadMs: loadedAt - startedAt, totalMs: Date.now() - startedAt })}`
    );
  };

  const match = (mediaId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const waiting = queued.get(mediaId);
    if (waiting) return waiting;
    markPending(mediaId, true);
    const run = chain.then(async () => {
      queued.delete(mediaId);
      if (stopped) return;
      try {
        await matchShow(mediaId);
        markPending(mediaId, false);
      } catch (err) {
        // Kept pending: the next signature of the show or the next start matches it again.
        log(`[skip-detect] show.failed ${JSON.stringify({ mediaId, error: err instanceof Error ? err.message : String(err) })}`);
      }
    });
    queued.set(mediaId, run);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    signatureRecorded: async ({ mediaId, episodeId, objectKey, signature }) => {
      try {
        await deps.libraryDb.call("upsertSkipAnalysis", [mediaId, episodeId, SKIP_SIGNATURE_ANALYSIS_KIND, { objectKey, signature } satisfies CachedSkipSignature]);
      } catch (err) {
        log(`[skip-detect] signature.cache_failed ${JSON.stringify({ mediaId, episodeId, error: err instanceof Error ? err.message : String(err) })}`);
      }
      await match(mediaId);
    },
    match,
    resume: async () => {
      loadPending();
      const ids = [...pending];
      if (ids.length > 0) log(`[skip-detect] resume ${JSON.stringify({ shows: ids.length })}`);
      await Promise.all(ids.map((id) => match(id)));
    },
    stop: () => {
      stopped = true;
    },
  };
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
