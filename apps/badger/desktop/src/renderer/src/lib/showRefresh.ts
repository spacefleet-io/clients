import type { TitleDetails } from "@/api";
import type {
  EpisodeMoveSuggestion,
  MediaDetails,
  MediaRow,
  ShowEpisodeNotListed,
  ShowEpisodeRefreshResult,
  ShowEpisodeSlot,
} from "@/lib/libraryDb";
import { MetadataRequestError } from "@space/metadata-client";

/**
 * LIB-SHOW-01 background refresh: a show that is still airing gets its season
 * and episode lists fetched again, and `refreshShowEpisodes` merges the new
 * episodes into the library (keeping every stored episode id). The library op
 * stream then carries them to the TV, the phone and Kodi.
 *
 * Per show, the desktop remembers when it last refreshed it and what the catalog said
 * about it (status, next air date), in `localStorage` under
 * `SHOW_REFRESH_STATE_KEY`. That bookkeeping is per machine on purpose: the
 * library only holds what every device shows, and a second desktop refreshing
 * the same show again is harmless (the merge is idempotent).
 *
 * A show is refreshed when:
 *   - it was never refreshed on this machine, or
 *   - its last refresh is `SHOW_REFRESH_MAX_AGE_MS` (1 day) old, or
 *   - the next episode the catalog announced airs today (or aired) and the show was
 *     last checked before that day.
 * Ended and cancelled shows are not refreshed again. The check always runs on
 * the desktop (the mode with the user's own key that skipped it was removed, META-DIRECT-03).
 * A show whose last attempt failed waits `SHOW_REFRESH_FAILURE_RETRY_MS` (1 day) and is tried after the others.
 *
 * LIB-SHOW-02: the merge never removes anything. Episodes the catalog provably stopped
 * listing are remembered per show (`notListed`), and `pendingShowDelistings`
 * offers them to the user once two checks a day apart both missed them.
 * LIB-SHOW-04: an episode the user has a file for is never offered for removal;
 * it carries the move the latest check suggests for it, offered after the same
 * two-check proof, and a "No" is remembered like "Keep".
 */

/** A running show is checked once a day (Chris 2026-10-29: "once a day seems fine for a check"). */
export const SHOW_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** LIB-SHOW-02: an episode is offered for removal only once two checks this far apart both missed it. */
export const SHOW_DELISTING_CONFIRM_MS = 24 * 60 * 60 * 1000;
/** Gap between two shows: one catalog fetch at a time. */
export const SHOW_REFRESH_REQUEST_GAP_MS = 2_000;
/** Consecutive network or service failures after which the pass stops until the next one. */
export const SHOW_REFRESH_MAX_CONSECUTIVE_FAILURES = 3;
/** A show whose last attempt failed is tried again after this long. */
export const SHOW_REFRESH_FAILURE_RETRY_MS = 24 * 60 * 60 * 1000;
export const SHOW_REFRESH_STATE_KEY = "sf.showRefresh.v1";

/** catalog statuses of a show that will not get new episodes. */
const FINISHED_STATUSES: Record<string, true> = { ended: true, canceled: true, cancelled: true };

/** An episode the catalog did not list at a check (LIB-SHOW-02), with when it was first and last found missing. */
export type NotListedSighting = {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** LIB-SHOW-04: set for an episode that has a file; the move the latest check suggests for it. */
  move?: EpisodeMoveSuggestion;
};

export type ShowRefreshEntry = {
  /** Last successful refresh, or "" when none has succeeded yet. */
  refreshedAt: string;
  status: string | null;
  nextEpisodeAirDate: string | null;
  /** Set when the last attempt failed; cleared by the next success. */
  lastFailedAt?: string;
  /** LIB-SHOW-02/04: stored episodes the last successful check found missing from the catalog. */
  notListed?: Record<string, NotListedSighting>;
  /** LIB-SHOW-02/04: episode ids the user chose to keep ("Keep", "No"); not offered again while they stay missing. */
  declined?: string[];
};

export type ShowRefreshState = Record<string, ShowRefreshEntry>;

export type ShowRefreshDeps = {
  fetchDetails: (catalogId: number, media: MediaRow) => Promise<TitleDetails>;
  refreshShowEpisodes: (mediaId: string, item: TitleDetails) => Promise<ShowEpisodeRefreshResult>;
  /** True while an import is running: the pass stands down and leaves the rest for the next one. */
  isLibraryBusy: () => Promise<boolean>;
  loadState: () => ShowRefreshState;
  saveState: (state: ShowRefreshState) => void;
  sleep: (ms: number) => Promise<void>;
  log: (message: string, details: Record<string, unknown>) => void;
  now?: () => number;
  isCancelled?: () => boolean;
};

export type ShowRefreshSummary = {
  candidates: number;
  due: number;
  refreshed: number;
  changed: number;
  addedEpisodes: number;
  failed: number;
  stoppedBecause: "done" | "busy" | "failures" | "cancelled";
};

export const isFinishedShowStatus = (status: string | null | undefined) =>
  typeof status === "string" && FINISHED_STATUSES[status.trim().toLowerCase()] === true;

/**
 * True when a failure says the metadata service or the network is down, so the
 * rest of the pass would fail too. A show the catalog has no page for (a 404, or the
 * metadata server's `missing_metadata` answer) fails on its own and does not.
 */
export const isPassWideFailure = (err: unknown): boolean => {
  if (err instanceof MetadataRequestError) return err.status !== 404;
  if (err instanceof Error && err.message === "CATALOG_404") return false;
  return true;
};

/** Why a show is due now, or null when it is not. */
export const showRefreshDueReason = (
  entry: ShowRefreshEntry | undefined,
  nowMs: number
): "never" | "stale" | "air-day" | null => {
  if (entry?.lastFailedAt) {
    const failedAtMs = Date.parse(entry.lastFailedAt);
    if (Number.isFinite(failedAtMs) && nowMs - failedAtMs < SHOW_REFRESH_FAILURE_RETRY_MS) return null;
  }
  if (!entry || entry.refreshedAt === "") return "never";
  if (isFinishedShowStatus(entry.status)) return null;
  const refreshedAtMs = Date.parse(entry.refreshedAt);
  if (!Number.isFinite(refreshedAtMs) || nowMs - refreshedAtMs >= SHOW_REFRESH_MAX_AGE_MS) return "stale";
  // The announced air day has come and the show was last checked before it: check once on that day.
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const checkedOn = entry.refreshedAt.slice(0, 10);
  if (entry.nextEpisodeAirDate && entry.nextEpisodeAirDate <= today && checkedOn < entry.nextEpisodeAirDate) return "air-day";
  return null;
};

const parseSlot = (value: unknown): ShowEpisodeSlot | null => {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.seasonNumber !== "number" || typeof s.episodeNumber !== "number") return null;
  return { id: s.id, seasonNumber: s.seasonNumber, episodeNumber: s.episodeNumber, title: typeof s.title === "string" ? s.title : "" };
};

/** A stored suggestion; anything unreadable falls back to keep-or-pick-by-hand, never to a move. */
export const parseMoveSuggestion = (value: unknown): EpisodeMoveSuggestion => {
  if (!value || typeof value !== "object") return { kind: "none" };
  const s = value as Record<string, unknown>;
  if (s.kind === "move") {
    const target = parseSlot(s.target);
    if (target) return { kind: "move", target };
  }
  if (s.kind === "merged") {
    const into = parseSlot(s.into);
    const partIds = Array.isArray(s.partIds) ? s.partIds.filter((id): id is string => typeof id === "string") : [];
    if (into && partIds.length > 1) return { kind: "merged", into, partIds };
  }
  return { kind: "none" };
};

const parseNotListed = (value: unknown): Record<string, NotListedSighting> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, NotListedSighting> = {};
  for (const [episodeId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (
      typeof s.seasonNumber !== "number" ||
      typeof s.episodeNumber !== "number" ||
      typeof s.title !== "string" ||
      typeof s.firstSeenAt !== "string" ||
      typeof s.lastSeenAt !== "string"
    ) {
      continue;
    }
    out[episodeId] = {
      seasonNumber: s.seasonNumber,
      episodeNumber: s.episodeNumber,
      title: s.title,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      ...("move" in s ? { move: parseMoveSuggestion(s.move) } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const parseShowRefreshState = (raw: string | null): ShowRefreshState => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: ShowRefreshState = {};
    for (const [mediaId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.refreshedAt !== "string") continue;
      const notListed = parseNotListed(entry.notListed);
      const declined = Array.isArray(entry.declined) ? entry.declined.filter((id): id is string => typeof id === "string") : [];
      state[mediaId] = {
        refreshedAt: entry.refreshedAt,
        status: typeof entry.status === "string" ? entry.status : null,
        nextEpisodeAirDate: typeof entry.nextEpisodeAirDate === "string" ? entry.nextEpisodeAirDate : null,
        ...(typeof entry.lastFailedAt === "string" ? { lastFailedAt: entry.lastFailedAt } : {}),
        ...(notListed ? { notListed } : {}),
        ...(declined.length > 0 ? { declined } : {}),
      };
    }
    return state;
  } catch {
    return {};
  }
};

/**
 * The sightings after a successful check: an episode still missing keeps its first sighting, one the catalog lists
 * again is forgotten (a later sighting starts over), and a "keep" only lasts while the episode stays missing.
 */
const trackNotListed = (
  previous: ShowRefreshEntry | undefined,
  notListed: ShowEpisodeNotListed[],
  seenAt: string
): Pick<ShowRefreshEntry, "notListed" | "declined"> => {
  if (notListed.length === 0) return {};
  const sightings: Record<string, NotListedSighting> = {};
  for (const episode of notListed) {
    sightings[episode.id] = {
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      firstSeenAt: previous?.notListed?.[episode.id]?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
      ...(episode.move ? { move: episode.move } : {}),
    };
  }
  const declined = (previous?.declined ?? []).filter((id) => id in sightings);
  return { notListed: sightings, ...(declined.length > 0 ? { declined } : {}) };
};

/** A delisted episode with a file and the move suggested for it (LIB-SHOW-04). */
export type ShowEpisodeMoveOffer = ShowEpisodeSlot & { move: EpisodeMoveSuggestion };

/** Per show: file-less episodes to offer for removal (LIB-SHOW-02) and episodes with a file to suggest a move for (LIB-SHOW-04). */
export type ShowDelisting = { mediaId: string; episodes: ShowEpisodeNotListed[]; moves: ShowEpisodeMoveOffer[] };

/** LIB-SHOW-02/04: what to ask about, per show: missing on two checks a day apart and not kept. */
export const pendingShowDelistings = (state: ShowRefreshState): ShowDelisting[] => {
  const pending: ShowDelisting[] = [];
  for (const [mediaId, entry] of Object.entries(state)) {
    const declined = new Set(entry.declined ?? []);
    const confirmed = Object.entries(entry.notListed ?? {})
      .filter(([episodeId, sighting]) => {
        if (declined.has(episodeId)) return false;
        const span = Date.parse(sighting.lastSeenAt) - Date.parse(sighting.firstSeenAt);
        return Number.isFinite(span) && span >= SHOW_DELISTING_CONFIRM_MS;
      })
      .sort(([, a], [, b]) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
    const slot = (id: string, sighting: NotListedSighting): ShowEpisodeSlot => ({
      id,
      seasonNumber: sighting.seasonNumber,
      episodeNumber: sighting.episodeNumber,
      title: sighting.title,
    });
    const episodes = confirmed.filter(([, sighting]) => !sighting.move).map(([id, sighting]) => slot(id, sighting));
    const moves = confirmed
      .filter(([, sighting]) => sighting.move)
      .map(([id, sighting]) => ({ ...slot(id, sighting), move: sighting.move! }));
    if (episodes.length > 0 || moves.length > 0) pending.push({ mediaId, episodes, moves });
  }
  return pending;
};

/**
 * LIB-SHOW-04 pick-by-hand list: the show's episodes that have no file and that the catalog still lists (not one of
 * `notListedIds`), in season order. A move never adds a file to an episode that has one.
 */
export const episodeMoveChoices = (
  details: Pick<MediaDetails, "episodes" | "files">,
  notListedIds: ReadonlySet<string>
): ShowEpisodeSlot[] => {
  const withFile = new Set(
    details.files.filter((file) => file.season != null && file.episode != null).map((file) => `${file.season}:${file.episode}`)
  );
  return details.episodes
    .filter((episode) => !notListedIds.has(episode.id) && !withFile.has(`${episode.seasonNumber}:${episode.episodeNumber}`))
    .map((episode) => ({ id: episode.id, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, title: episode.name }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
};

/**
 * Records the user's answer: "removed" (LIB-SHOW-02) and "moved" (LIB-SHOW-04) forget the sightings; "kept"
 * ("Keep", or "No" to a move) means the episodes are not offered again while they stay missing.
 */
export const resolveShowDelisting = (
  state: ShowRefreshState,
  mediaId: string,
  episodeIds: string[],
  decision: "removed" | "moved" | "kept"
): ShowRefreshState => {
  const entry = state[mediaId];
  if (!entry) return state;
  const next: ShowRefreshEntry = { ...entry };
  if (decision === "removed" || decision === "moved") {
    const remaining = Object.fromEntries(Object.entries(entry.notListed ?? {}).filter(([id]) => !episodeIds.includes(id)));
    if (Object.keys(remaining).length > 0) next.notListed = remaining;
    else delete next.notListed;
  } else {
    next.declined = [...new Set([...(entry.declined ?? []), ...episodeIds])];
  }
  return { ...state, [mediaId]: next };
};

export const runShowRefreshPass = async (media: MediaRow[], deps: ShowRefreshDeps): Promise<ShowRefreshSummary> => {
  const now = deps.now ?? Date.now;
  const shows = media.filter((row) => row.type === "tv" && typeof row.catalogId === "number" && row.catalogId > 0);
  const state = deps.loadState();
  const known = new Set(shows.map((row) => row.id));
  // The dialog (LIB-SHOW-02) saves the user's answers to the same store while a pass runs, so every write
  // re-reads what is stored and replaces only this show's entry, built from the stored one. Shows that left
  // the library are forgotten on the way.
  const writeEntry = (mediaId: string, build: (stored: ShowRefreshEntry | undefined) => ShowRefreshEntry) => {
    const fresh = deps.loadState();
    for (const id of Object.keys(fresh)) if (!known.has(id)) delete fresh[id];
    fresh[mediaId] = build(fresh[mediaId]);
    deps.saveState(fresh);
  };

  // Never-refreshed and stale shows first; a show whose last attempt failed goes last.
  const due = shows
    .map((row) => ({ row, reason: showRefreshDueReason(state[row.id], now()) }))
    .filter((candidate): candidate is { row: MediaRow; reason: NonNullable<typeof candidate.reason> } =>
      Boolean(candidate.reason)
    )
    .sort((a, b) => Number(Boolean(state[a.row.id]?.lastFailedAt)) - Number(Boolean(state[b.row.id]?.lastFailedAt)));
  const summary: ShowRefreshSummary = {
    candidates: shows.length,
    due: due.length,
    refreshed: 0,
    changed: 0,
    addedEpisodes: 0,
    failed: 0,
    stoppedBecause: "done",
  };
  deps.log("[show-refresh] pass start", { candidates: shows.length, due: due.length });

  let consecutiveFailures = 0;
  for (const [index, { row, reason }] of due.entries()) {
    if (deps.isCancelled?.()) {
      summary.stoppedBecause = "cancelled";
      break;
    }
    if (await deps.isLibraryBusy()) {
      deps.log("[show-refresh] import running, standing down", { remaining: due.length - index });
      summary.stoppedBecause = "busy";
      break;
    }
    const catalogId = row.catalogId as number;
    try {
      const details = await deps.fetchDetails(catalogId, row);
      const result = await deps.refreshShowEpisodes(row.id, details);
      const refreshedAt = new Date(now()).toISOString();
      writeEntry(row.id, (previous) => ({
        refreshedAt,
        status: details.status ?? null,
        nextEpisodeAirDate: details.nextEpisodeAirDate ?? null,
        ...trackNotListed(previous, result.notListed ?? [], refreshedAt),
      }));
      summary.refreshed += 1;
      if (result.changed) summary.changed += 1;
      summary.addedEpisodes += result.addedEpisodes;
      consecutiveFailures = 0;
      deps.log("library.showRefresh", {
        mediaId: row.id,
        catalogId,
        reason,
        source: "background",
        status: details.status ?? null,
        nextEpisodeAirDate: details.nextEpisodeAirDate ?? null,
        ...result,
      });
    } catch (err) {
      summary.failed += 1;
      const passWide = isPassWideFailure(err);
      consecutiveFailures = passWide ? consecutiveFailures + 1 : 0;
      writeEntry(row.id, (previous) => ({
        ...previous,
        refreshedAt: previous?.refreshedAt ?? "",
        status: previous?.status ?? null,
        nextEpisodeAirDate: previous?.nextEpisodeAirDate ?? null,
        lastFailedAt: new Date(now()).toISOString(),
      }));
      deps.log("[show-refresh] show failed", {
        mediaId: row.id,
        catalogId,
        passWide,
        retryInMs: SHOW_REFRESH_FAILURE_RETRY_MS,
        error: err instanceof Error ? err.message : String(err),
      });
      if (consecutiveFailures >= SHOW_REFRESH_MAX_CONSECUTIVE_FAILURES) {
        summary.stoppedBecause = "failures";
        break;
      }
    }
    if (index < due.length - 1) await deps.sleep(SHOW_REFRESH_REQUEST_GAP_MS);
  }
  deps.log("[show-refresh] pass done", { ...summary });
  return summary;
};
