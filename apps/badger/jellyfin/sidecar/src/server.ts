import type { MediaDetails } from "@space/shared/libraryTypes";
import type { ApiProfile } from "@space/shared/profiles";
import type { SubtitlePref, TrackPrefs, TrackPrefsPatch } from "@space/shared/trackPrefs";
import {
  buildHlsUnit,
  mediaPathBase,
  resolvePlayableUnit,
  subtitleExtension,
  type IntegrationLibrary,
} from "./library";
import { buildMasterPlaylist, buildTrackPlaylist } from "./hls";
import { errorMessage, errorPayload, errorStatus } from "./errors";
import { decideProgress, type ProgressDecision } from "./progress";
import type { ObjectStore } from "./objectStore";
import type { PairingSnapshot } from "./pairing";
import type { JellyfinStreamSlots } from "./streamSlots";
import type { IntegrationUpdateRequired } from "./updateRequired";

export const API_PREFIX = "/integration/v1";

export type IntegrationStatus = {
  /** "starting" | "update_required" | "needs_login" | "needs_key" | "needs_profile" | "ok" | "signed_out" | "error" */
  state: string;
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  accessState: "free" | "paid" | "unpaid" | "unknown";
  paidUntil: string | null;
  wipeAt: string | null;
  libraryVersion: number | null;
  mediaCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  apiUrl: string;
  version: string;
  /** Current pairing code, if one was requested (ACCT-PAIR-01). */
  pairing: PairingSnapshot | null;
  /** Why this device signed out (401 / revoked / user), kept until the next sign-in or pairing. */
  signedOutReason: string | null;
  /** The stored library key was refused by the library key probe. */
  keyRejected: boolean;
  /** The one profile this server follows (INTG-PROF-01); null until it is picked. */
  profile: IntegrationProfileRef | null;
  /** The account's profiles from the last `GET /profiles` (oldest first), null before the first answer. */
  profiles: ApiProfile[] | null;
  /** INTG-PROF-01: why no profile is followed while state is `needs_profile` outside pairing: `deleted` elsewhere, or `choose` (session from before profiles, several on the account). */
  profileNeeded: "deleted" | "choose" | null;
  /** REL-CD-29 / LIB-FMT-13: this build was refused or the library is too new for it; nothing syncs until the plugin is updated. */
  updateRequired: IntegrationUpdateRequired | null;
};

export type IntegrationProfileRef = { id: string; name: string; isMain: boolean };

/** `GET /integration/v1/profiles`: `required` = nothing syncs until a profile is picked. */
export type IntegrationProfiles = { profile: IntegrationProfileRef | null; profiles: ApiProfile[]; required: boolean };

export type ProgressWrite =
  | { kind: "resume" | "watched"; progressPct: number; positionSeconds: number; durationSeconds: number }
  | { kind: "clear"; progressPct: 0 };

export type TrackPrefsView = Pick<TrackPrefs, "audioLanguage" | "subtitle"> & { updatedAt: string | null };

export type IntegrationDeps = {
  getStatus(): IntegrationStatus;
  /** False until the library snapshot is open (no key / signed out / still loading). */
  isLibraryReady(): boolean;
  /**
   * True while the runtime still loads its stored state and runs its first login / profile / library open.
   * The port is already open then: /status and /pairing/status answer, every other route is 503 `starting`.
   */
  isStarting(): boolean;
  getLibrary(): IntegrationLibrary;
  getDetails(mediaId: string): MediaDetails | null;
  objectStore: Pick<ObjectStore, "get" | "registerSequence" | "prefetch">;
  loadImage(ref: string, kind: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  recordProgress(input: { mediaId: string; episodeId: string | null; write: ProgressWrite }): Promise<void>;
  /** The movie's / show's remembered audio + subtitle choice (PLAY-TRACK-04); null fields = no choice recorded. */
  getTrackPrefs(mediaId: string): TrackPrefsView;
  /** Writes only the fields present in the patch; the other keeps its value. Resolves when the op is queued. */
  setTrackPrefs(mediaId: string, patch: TrackPrefsPatch): Promise<TrackPrefsView>;
  deleteMedia(mediaId: string): Promise<{ deletedKeys: number; reclaimedBytes: number }>;
  deleteEpisode(mediaId: string, episodeId: string): Promise<{ deletedKeys: number; reclaimedBytes: number; deletedFile: boolean }>;
  currentVersion(): number;
  waitForChange(since: number, timeoutMs: number, signal: AbortSignal): Promise<number>;
  login(input: { email: string; password: string; twoFactorCode?: string | null; apiUrl?: string | null }): Promise<IntegrationStatus>;
  startPairing(input: { deviceName: string; apiUrl?: string | null }): Promise<PairingSnapshot>;
  cancelPairing(): void;
  signOut(): Promise<void>;
  /** Picks the followed profile (pairing with several profiles, or a later change from the settings). */
  chooseProfile(profileId: string): Promise<IntegrationStatus>;
  listProfiles(): Promise<IntegrationProfiles>;
  /** The server's place in the profile's stream limit (ACCT-STREAM-01..04), asked by the plugin for every Jellyfin playback. */
  streams: Pick<JellyfinStreamSlots, "start" | "poll" | "stop">;
  log(message: string, meta?: Record<string, unknown>): void;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** `"off"` / null / `{language, format?, forced?}`; undefined = malformed. */
const parseSubtitle = (value: unknown): SubtitlePref | "off" | null | undefined => {
  if (value === null || value === "off") return value;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const language = asString(record.language);
  if (!language) return undefined;
  const format = asString(record.format);
  return {
    language,
    ...(format ? { format } : {}),
    ...(typeof record.forced === "boolean" ? { forced: record.forced } : {}),
  };
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const PLAYLIST_HEADERS = { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" };

/** Maps tunnel / api errors to the integration error contract. 402 keeps the wipe date (ACCT-UNPAID-03). */
export const errorResponse = (error: unknown): Response => {
  const status = errorStatus(error);
  const payload = errorPayload(error);
  const message = errorMessage(error);
  if (status === 402 || message === "subscription_unpaid") {
    return json({ error: "subscription_unpaid", wipeAt: payload.wipeAt ?? null }, 402);
  }
  if (status === 401) return json({ error: "unauthorized" }, 401);
  // INTG-PROF-01: no profile followed (deleted elsewhere, or not picked yet): viewing writes wait for a pick.
  if (status === 409 && message === "profile_needed") return json({ error: "profile_needed" }, 409);
  if (status === 404 || message === "download_source_missing") return json({ error: "not_found", detail: message }, 404);
  return json({ error: "upstream_error", detail: message }, 502);
};

const notFound = (detail?: string) => json({ error: "not_found", ...(detail ? { detail } : {}) }, 404);
const badRequest = (detail: string) => json({ error: "bad_request", detail }, 400);

const parseRange = (header: string | null, size: number): { start: number; end: number } | "invalid" | null => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
};

const binaryResponse = (req: Request, payload: Buffer<ArrayBuffer>, contentType: string, extra: Record<string, string> = {}) => {
  const range = parseRange(req.headers.get("range"), payload.byteLength);
  const base = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "private, max-age=3600", ...extra };
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${payload.byteLength}` } });
  }
  if (range) {
    const slice = payload.subarray(range.start, range.end + 1);
    return new Response(req.method === "HEAD" ? null : slice, {
      status: 206,
      headers: {
        ...base,
        "content-length": String(slice.byteLength),
        "content-range": `bytes ${range.start}-${range.end}/${payload.byteLength}`,
      },
    });
  }
  return new Response(req.method === "HEAD" ? null : payload, {
    status: 200,
    headers: { ...base, "content-length": String(payload.byteLength) },
  });
};

const SUBTITLE_CONTENT_TYPES: Record<string, string> = {
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  ass: "text/x-ssa; charset=utf-8",
  ssa: "text/x-ssa; charset=utf-8",
};

const readJson = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const value = await req.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const asString = (value: unknown) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Computes the library write for a progress report (pure: used by tests and the route). */
export const progressWriteFor = (
  details: MediaDetails,
  episodeId: string | null,
  body: { positionSeconds: number | null; durationSeconds: number | null; played: boolean | null }
): { write: ProgressWrite | null; decision: ProgressDecision | { kind: "clear" } | { kind: "ignore"; reason: string } } => {
  const unit = resolvePlayableUnit(details, episodeId);
  if (!unit) return { write: null, decision: { kind: "ignore", reason: "no_playable_unit" } };
  const duration = body.durationSeconds && body.durationSeconds > 0 ? body.durationSeconds : unit.durationSeconds;
  if (body.played === false) return { write: { kind: "clear", progressPct: 0 }, decision: { kind: "clear" } };
  if (body.played === true) {
    const length = duration ?? 0;
    const write: ProgressWrite = {
      kind: "watched",
      progressPct: 100,
      positionSeconds: length,
      durationSeconds: length,
    };
    return { write, decision: { kind: "watched", progressPct: 100, positionSeconds: length, durationSeconds: length } };
  }
  const credits = unit.skipMarkers.find((marker) => marker.type === "credits");
  const decision = decideProgress({
    positionSeconds: body.positionSeconds ?? Number.NaN,
    durationSeconds: duration ?? Number.NaN,
    creditsStartSeconds: credits?.startSeconds ?? null,
  });
  if (decision.kind === "ignore") return { write: null, decision };
  return {
    write: {
      kind: decision.kind,
      progressPct: decision.progressPct,
      positionSeconds: decision.positionSeconds,
      durationSeconds: decision.durationSeconds,
    } as ProgressWrite,
    decision,
  };
};

type MediaRoute = { mediaId: string; episodeId: string | null; qualityKey: string; file: string };

/** media/<id>[/<episodeId>]/<qualityKey>/<file> */
export const parseMediaRoute = (segments: string[]): MediaRoute | null => {
  if (segments.length !== 4 && segments.length !== 3) return null;
  const decoded = segments.map((part) => decodeURIComponent(part));
  const file = decoded[decoded.length - 1];
  const qualityKey = decoded[decoded.length - 2];
  const mediaId = decoded[0];
  const episodeId = decoded.length === 4 ? decoded[1] : null;
  return { mediaId, episodeId, qualityKey, file };
};

export const handleIntegrationRequest = async (req: Request, deps: IntegrationDeps): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname === "/health") return json({ ok: true });
  if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return notFound();
  const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, "");
  const segments = route.split("/").filter((part) => part.length > 0);
  const head = segments[0] ?? "";
  const origin = url.origin;
  const method = req.method.toUpperCase();
  const startedAt = Date.now();

  try {
    const response = await dispatch();
    deps.log("integration request", { method, path: url.pathname, status: response.status, ms: Date.now() - startedAt });
    return response;
  } catch (error) {
    deps.log("integration request failed", {
      method,
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(error);
  }

  async function dispatch(): Promise<Response> {
    if (head === "status" && method === "GET") return json(deps.getStatus());
    if (head === "pairing" && segments[1] === "status" && method === "GET") return json({ pairing: deps.getStatus().pairing });

    // Session routes would race the first tick's login / profile pick on half-loaded state.
    if (deps.isStarting()) {
      return json({ error: "starting", status: deps.getStatus() }, 503);
    }

    if (head === "login" && method === "POST") {
      const body = await readJson(req);
      const email = asString(body?.email);
      const password = typeof body?.password === "string" ? body.password : null;
      if (!email || !password) return badRequest("email and password required");
      try {
        return json(
          await deps.login({
            email,
            password,
            twoFactorCode: asString(body?.twoFactorCode),
            apiUrl: asString(body?.apiUrl),
          })
        );
      } catch (error) {
        return json({ error: errorMessage(error), detail: errorPayload(error) }, 401);
      }
    }

    if (head === "pairing") {
      if (segments[1] === "start" && method === "POST") {
        const body = await readJson(req);
        try {
          const snapshot = await deps.startPairing({ deviceName: asString(body?.deviceName) ?? "", apiUrl: asString(body?.apiUrl) });
          return json(snapshot);
        } catch (error) {
          return json({ error: errorMessage(error) }, errorStatus(error) === 409 ? 409 : 502);
        }
      }
      if (segments[1] === "cancel" && method === "POST") {
        deps.cancelPairing();
        return json({ ok: true });
      }
      return notFound();
    }

    if (head === "signout" && method === "POST") {
      await deps.signOut();
      return json({ ok: true });
    }

    if (head === "profiles" && method === "GET") {
      try {
        return json(await deps.listProfiles());
      } catch (error) {
        return json({ error: errorMessage(error) }, errorStatus(error) === 409 ? 409 : 502);
      }
    }

    if (head === "profile" && method === "POST") {
      const body = await readJson(req);
      const profileId = asString(body?.profileId);
      if (!profileId) return badRequest("profileId required");
      try {
        return json(await deps.chooseProfile(profileId));
      } catch (error) {
        const status = errorStatus(error);
        return json({ error: errorMessage(error) }, status === 404 || status === 409 ? status : 502);
      }
    }

    // Everything below needs an open library.
    if (!deps.isLibraryReady()) {
      return json({ error: "library_not_ready", status: deps.getStatus() }, 503);
    }

    if (head === "library" && method === "GET") return json(deps.getLibrary());

    if (head === "changes" && method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      const waitSeconds = Math.min(60, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
      const version = await deps.waitForChange(since, waitSeconds * 1000, req.signal);
      return json({ version, changed: version !== since });
    }

    if (head === "events" && method === "GET") {
      const encoder = new TextEncoder();
      let lastVersion = deps.currentVersion();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          send("library", { version: lastVersion });
          try {
            while (!req.signal.aborted) {
              const next = await deps.waitForChange(lastVersion, 25_000, req.signal);
              if (next !== lastVersion) {
                lastVersion = next;
                send("library", { version: next });
              } else {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              }
            }
          } catch {
            // client went away
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
      });
    }

    if (head === "image" && method === "GET") {
      const ref = url.searchParams.get("ref");
      const kind = url.searchParams.get("kind") ?? "poster";
      if (!ref) return badRequest("ref required");
      const image = await deps.loadImage(ref, kind);
      return binaryResponse(req, Buffer.from(image.bytes), image.contentType);
    }

    if (head === "media" && (method === "GET" || method === "HEAD")) {
      const parsed = parseMediaRoute(segments.slice(1));
      if (!parsed) return notFound("media route");
      const details = deps.getDetails(parsed.mediaId);
      if (!details) return notFound("media");
      const unit = resolvePlayableUnit(details, parsed.episodeId);
      if (!unit) return notFound("playable unit");
      const hls = buildHlsUnit(unit, parsed.qualityKey, deps.getTrackPrefs(parsed.mediaId).audioLanguage);
      if (!hls) return notFound("quality");
      const unitBase = `${origin}${mediaPathBase(parsed.mediaId, parsed.episodeId)}/${encodeURIComponent(parsed.qualityKey)}`;
      if (parsed.file === "master.m3u8") {
        const preferred = hls.audio.find((entry) => entry.isDefault)?.id ?? null;
        return new Response(buildMasterPlaylist(hls, unitBase, preferred), { headers: PLAYLIST_HEADERS });
      }
      const videoMatch = /^video-(.+)\.m3u8$/.exec(parsed.file);
      const audioMatch = /^audio-(.+)\.m3u8$/.exec(parsed.file);
      const variant = videoMatch
        ? hls.videos.find((entry) => entry.id === videoMatch[1])
        : audioMatch
          ? hls.audio.find((entry) => entry.id === audioMatch[1])
          : null;
      if (!variant) return notFound("variant");
      // Only the media segments warm their successors, and the playlist warms only the init segment: a seek restarts
      // Jellyfin's ffmpeg, which reads this playlist and the init segment again before asking for the seek target, so
      // warming from there would fetch the start of the film on every seek, against the wanted segment (INTG-JF-06).
      deps.objectStore.registerSequence(variant.track.segments.map((segment) => segment.key));
      deps.objectStore.prefetch([variant.track.initKey]);
      return new Response(buildTrackPlaylist(variant.track, origin, videoMatch ? "video" : "audio"), {
        headers: PLAYLIST_HEADERS,
      });
    }

    if (head === "object" && (method === "GET" || method === "HEAD")) {
      const key = decodeURIComponent(segments.slice(1).join("/")).replace(/\.m4s$/, "");
      if (!key) return badRequest("key required");
      const payload = await deps.objectStore.get(key, "playback");
      return binaryResponse(req, payload, "application/octet-stream", { "cache-control": "private, max-age=600" });
    }

    if (head === "subtitles" && (method === "GET" || method === "HEAD")) {
      const mediaId = decodeURIComponent(segments[1] ?? "");
      const trackFile = decodeURIComponent(segments[2] ?? "");
      const trackId = trackFile.replace(/\.[^.]+$/, "");
      const details = deps.getDetails(mediaId);
      const track = details?.subtitleTracks.find((entry) => entry.id === trackId);
      if (!details || !track?.objectKey) return notFound("subtitle");
      const payload = await deps.objectStore.get(track.objectKey, "playback");
      const extension = subtitleExtension(track.format);
      return binaryResponse(req, payload, SUBTITLE_CONTENT_TYPES[extension] ?? "application/octet-stream");
    }

    if (head === "progress" && method === "POST") {
      const body = await readJson(req);
      const mediaId = asString(body?.mediaId);
      const episodeId = asString(body?.episodeId);
      if (!mediaId) return badRequest("mediaId required");
      const details = deps.getDetails(mediaId);
      if (!details) return notFound("media");
      if (details.type === "tv" && !episodeId) return badRequest("episodeId required for shows");
      const played = typeof body?.played === "boolean" ? body.played : null;
      const outcome = progressWriteFor(details, episodeId, {
        positionSeconds: asNumber(body?.positionSeconds),
        durationSeconds: asNumber(body?.durationSeconds),
        played,
      });
      if (!outcome.write) {
        return json({ recorded: false, reason: "reason" in outcome.decision ? outcome.decision.reason : "ignored" });
      }
      await deps.recordProgress({ mediaId, episodeId, write: outcome.write });
      return json({ recorded: true, kind: outcome.write.kind, progressPct: outcome.write.progressPct });
    }

    if (head === "tracks" && method === "GET") {
      const mediaId = decodeURIComponent(segments[1] ?? "");
      if (!mediaId) return badRequest("mediaId required");
      if (!deps.getDetails(mediaId)) return notFound("media");
      return json(deps.getTrackPrefs(mediaId));
    }

    if (head === "tracks" && method === "POST") {
      const body = await readJson(req);
      const mediaId = asString(body?.mediaId);
      if (!mediaId) return badRequest("mediaId required");
      if (!deps.getDetails(mediaId)) return notFound("media");
      // The record is per movie / per show, never per episode: the caller's id is already the show's.
      const patch: TrackPrefsPatch = {};
      if (body && "audioLanguage" in body) patch.audioLanguage = asString(body.audioLanguage);
      if (body && "subtitle" in body) {
        const subtitle = parseSubtitle(body.subtitle);
        if (subtitle === undefined) return badRequest('subtitle must be "off", null or {language, format?, forced?}');
        patch.subtitle = subtitle;
      }
      if (!("audioLanguage" in patch) && !("subtitle" in patch)) return badRequest("audioLanguage or subtitle required");
      const prefs = await deps.setTrackPrefs(mediaId, patch);
      return json({ ok: true, ...prefs });
    }

    // ACCT-STREAM-01..04: the plugin reports each Jellyfin playback of a Badger item (StreamLimitGuard.cs).
    if (head === "stream" && method === "POST" && (segments[1] === "start" || segments[1] === "stop")) {
      const body = await readJson(req);
      const session = asString(body?.session);
      if (!session) return badRequest("session required");
      if (segments[1] === "stop") {
        await deps.streams.stop(session);
        return json({ ok: true });
      }
      const item = asString(body?.item);
      if (!item) return badRequest("item required");
      return json(
        await deps.streams.start({ session, item, deviceName: asString(body?.deviceName), language: asString(body?.language) ?? "en" })
      );
    }

    if (head === "stream" && method === "GET" && segments[1]) {
      return json(deps.streams.poll(decodeURIComponent(segments[1]), url.searchParams.get("language") ?? "en"));
    }

    if (head === "media" && method === "DELETE") {
      const mediaId = decodeURIComponent(segments[1] ?? "");
      const episodeId = segments[2] ? decodeURIComponent(segments[2]) : null;
      if (!mediaId) return badRequest("mediaId required");
      const details = deps.getDetails(mediaId);
      if (!details) return notFound("media");
      if (episodeId) {
        // One episode (INTG-DEL-01): only its file and storage keys go; the show stays.
        const result = await deps.deleteEpisode(mediaId, episodeId);
        return json({ ok: true, ...result });
      }
      const result = await deps.deleteMedia(mediaId);
      return json({ ok: true, ...result });
    }

    return notFound();
  }
};
