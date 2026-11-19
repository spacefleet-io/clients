import {
  buildSubtitleEntries,
  fillSubtitleFetchCopy,
  subtitleFetchCopy,
  subtitleFetchLabels,
  subtitleTitleMatchLabel,
  UnreadableSubtitleFileError,
  type StoredSubtitleFile,
  type SubtitleFetchCandidate,
  type SubtitleFetchEntry,
  type SubtitleFetchRequest,
  type SubtitleFetchTarget,
  type SubtitleTitleMatch,
} from "@space/shared/subtitleFetch";
import { subtitleFetchEntryPickable, subtitleVersionLine, type SubtitleVersionStep } from "@space/shared/subtitleFetchFlow";
import { LUA_OUTBOUND_CHANNELS, type SubtitleFetchView } from "@space/mpv-protocol";

/**
 * "Get more subtitles…" in the mpv player (PLAY-SUBGET-02): the shared "Get subtitles" flow drawn by sf-select.lua
 * over the paused video. The app does the search, download and storage; mpv only shows what this sends on
 * `sf-subtitle-fetch-json` and answers on `sf-subtitle-fetch` (`open`, `pick <key>`, `title <text>`, `cancel`). The
 * menu's "Try another version" row (PLAY-SUBGET-07) answers `version` and runs through the same panels.
 *
 * A media with no catalog id starts with the title field (PLAY-SUBGET-24): the typed title is looked up, the user picks
 * the film or show, then its catalog id is searched (never the file name, PLAY-SUBGET-14); the media's identification is
 * not changed. The menu's "Add a subtitle file…" row (PLAY-SUBGET-23) answers `add-file`: the OS file picker, then
 * the file is stored like a fetched subtitle and switched on.
 */

export type MpvSubtitleFetchMessage =
  | { action: "open" }
  | { action: "version" }
  | { action: "add-file" }
  | { action: "pick"; key: string }
  | { action: "title"; text: string }
  | { action: "cancel" };

/** The player's answer on `sf-subtitle-fetch`, or null for any other script message. */
export const parseSubtitleFetchMessage = (msg: unknown): MpvSubtitleFetchMessage | null => {
  if (!msg || typeof msg !== "object") return null;
  const { type, name, args } = msg as { type?: unknown; name?: unknown; args?: unknown };
  if (type !== "script_message" || name !== LUA_OUTBOUND_CHANNELS.SUBTITLE_FETCH || !Array.isArray(args)) return null;
  const [action, key] = args;
  if (action === "open" || action === "version" || action === "add-file" || action === "cancel") return { action };
  if (action === "pick" && typeof key === "string" && key.length > 0) return { action, key };
  // An emptied field still answers: the field shows again.
  if (action === "title") return { action, text: typeof key === "string" ? key : "" };
  return null;
};

// A title match's list key is `title:<catalogId>` (language keys never start with it).
const OTHER_TITLE_KEY = "other-title";

export type MpvSubtitleFetchDeps = {
  uiLanguage: string;
  /** The film or episode playing; null when it has no catalog id (searched by title, or nothing to search). */
  target: SubtitleFetchTarget | null;
  search: (request: SubtitleFetchRequest) => Promise<{ reachable: boolean; subtitles: SubtitleFetchCandidate[] }>;
  /**
   * No catalog id but a title search can stand in (PLAY-SUBGET-24, `subtitleFetchNeedsTitle`): the title the app shows,
   * and the metadata service's title lookup. Absent with no `target`: the unavailable message.
   */
  findTitle?: { query: string; find: (query: string) => Promise<SubtitleTitleMatch[]> };
  /** The search target for the film or show picked by title (`subtitleFetchTarget(media, episodeId, match.catalogId)`). */
  targetFor?: (match: SubtitleTitleMatch) => SubtitleFetchTarget | null;
  /**
   * "Add a subtitle file…" (PLAY-SUBGET-23): the OS file picker (null when cancelled), and `storeSubtitleFile` bound
   * to this media (throws `UnreadableSubtitleFileError` before storing anything). Absent: `add-file` does nothing.
   */
  addFile?: {
    pick: () => Promise<{ name: string; content: string } | null>;
    store: (file: { name: string; content: string }) => Promise<StoredSubtitleFile>;
  };
  /** Stored and the "added" panel shown: the player switches the added file on and resumes. */
  onFileAdded?: (stored: StoredSubtitleFile) => void;
  /** Stops before adding anything once `signal` aborts (Escape while downloading or saving). */
  store: (entry: SubtitleFetchEntry, report: (stage: "downloading" | "saving") => void, signal: AbortSignal) => Promise<void>;
  show: (view: SubtitleFetchView) => void;
  /** Stored and the "added" panel shown: the player selects the new track and resumes. */
  onAdded: (entry: SubtitleFetchEntry) => void;
  /** Left without adding anything (Escape on the list, a message or the download): the player resumes. */
  onCancelled: () => void;
  /**
   * "Try another version" of the subtitle that is on (PLAY-SUBGET-07): its name, and the shared
   * `tryAnotherSubtitleVersion` bound to it. Absent: the row's `version` does nothing.
   */
  tryAnother?: {
    name: string;
    run: (
      report: (step: SubtitleVersionStep) => void,
      signal: AbortSignal
    ) => Promise<"replaced" | "none-left" | "unavailable" | "failed" | null>;
  };
  /** Replaced and the panel shown: the player switches the new file on and resumes. */
  onReplaced?: () => void;
  /** How long the "added" panel stays before playback resumes. */
  addedHoldMs?: number;
  wait?: (ms: number) => Promise<void>;
};

export type MpvSubtitleFetch = {
  handle: (message: MpvSubtitleFetchMessage) => void;
  /** Playback ended or the file changed: drop whatever runs, without resuming. */
  dispose: () => void;
};

// title: the title field; finding: looking the title up; titles: the matches; other-title: nothing found for the
// picked title, "Search another title" offered.
type Step = "idle" | "title" | "finding" | "titles" | "looking" | "list" | "other-title" | "message" | "busy" | "added";

export const createMpvSubtitleFetch = (deps: MpvSubtitleFetchDeps): MpvSubtitleFetch => {
  const copy = subtitleFetchCopy(deps.uiLanguage);
  const wait =
    deps.wait ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  let step: Step = "idle";
  let entries: SubtitleFetchEntry[] = [];
  // Bumped by every open / cancel / dispose: a search or store answering late for an earlier run is dropped.
  let run = 0;
  let storing: AbortController | null = null;
  let finishAdded: (() => void) | null = null;
  let matches: SubtitleTitleMatch[] = [];
  let lastQuery = deps.findTitle?.query ?? "";

  const message = (text: string) => {
    step = "message";
    deps.show({ panel: text, dismissable: true });
  };

  const open = async () => {
    const mine = ++run;
    entries = [];
    if (deps.target) return searchFor(deps.target, mine, false);
    if (deps.findTitle) return askTitle(deps.findTitle.query, copy.titlePrompt);
    message(copy.unavailable);
  };

  const askTitle = (query: string, prompt: string) => {
    step = "title";
    deps.show({ title: { prompt, field: copy.titleField, query } });
  };

  const findTitle = async (text: string) => {
    const finder = deps.findTitle;
    if (step !== "title" || !finder) return;
    const query = text.trim();
    if (!query) return askTitle("", copy.titlePrompt);
    const mine = ++run;
    lastQuery = query;
    step = "finding";
    deps.show({ panel: fillSubtitleFetchCopy(copy.findingTitle, { title: query }), dismissable: true });
    try {
      const found = await finder.find(query);
      if (mine !== run) return;
      matches = found;
    } catch {
      if (mine === run) message(copy.unavailable);
      return;
    }
    if (matches.length === 0) return askTitle(query, fillSubtitleFetchCopy(copy.noTitle, { title: query }));
    showTitles();
  };

  const showTitles = () => {
    step = "titles";
    deps.show({
      list: { prompt: copy.titlePrompt, items: matches.map((match) => ({ key: `title:${match.catalogId}`, label: subtitleTitleMatchLabel(match) })) },
    });
  };

  // The match is used for this search only: the media's identification is not changed (PLAY-SUBGET-24).
  const pickTitle = (key: string) => {
    const match = matches.find((item) => `title:${item.catalogId}` === key);
    if (!match) return;
    const target = deps.targetFor?.(match) ?? null;
    if (!target) return message(copy.unavailable);
    void searchFor(target, ++run, true);
  };

  const searchFor = async (target: SubtitleFetchTarget, mine: number, byTitle: boolean) => {
    step = "looking";
    deps.show({ panel: copy.looking, dismissable: true });
    try {
      const result = await deps.search(target.request);
      if (mine !== run) return;
      entries = buildSubtitleEntries({
        candidates: result.subtitles,
        libraryFileName: target.libraryFileName,
        existingTracks: target.existingTracks,
        uiLanguage: deps.uiLanguage,
        labels: subtitleFetchLabels(copy),
      });
      if (entries.length > 0) return showList();
      if (!result.reachable) return message(copy.unavailable);
      if (!byTitle) return message(copy.none);
      // Nothing for the picked film or show: offer another title (PLAY-SUBGET-24).
      step = "other-title";
      deps.show({ list: { prompt: copy.none, items: [{ key: OTHER_TITLE_KEY, label: copy.otherTitle }] } });
    } catch {
      if (mine === run) message(copy.unavailable);
    }
  };

  const showList = () => {
    step = "list";
    deps.show({
      list: {
        prompt: copy.pick,
        items: entries.map((entry) => ({
          key: entry.key,
          label: entry.already ? `${entry.name} · ${copy.already}` : entry.name,
        })),
      },
    });
  };

  const pick = async (key: string) => {
    if (step === "titles") return pickTitle(key);
    if (step === "other-title") return key === OTHER_TITLE_KEY ? askTitle(lastQuery, copy.titlePrompt) : undefined;
    const entry = step === "list" ? entries.find((item) => item.key === key) : undefined;
    if (!entry) return;
    // A subtitle the title already has stays listed, marked, and is never downloaded again (PLAY-SUBGET-24): mpv
    // closed the list on the pick, so it shows again.
    if (!subtitleFetchEntryPickable(entry)) return showList();
    const mine = run;
    step = "busy";
    const controller = new AbortController();
    storing = controller;
    deps.show({ panel: fillSubtitleFetchCopy(copy.getting, { language: entry.name }), dismissable: true });
    try {
      await deps.store(
        entry,
        (stage) => {
          if (mine === run) deps.show({ panel: stage === "downloading" ? copy.downloading : copy.saving, dismissable: true });
        },
        controller.signal
      );
    } catch {
      if (mine === run) message(fillSubtitleFetchCopy(copy.failed, { name: entry.name }));
      return;
    } finally {
      if (storing === controller) storing = null;
    }
    if (mine !== run) return;
    deps.show({ panel: fillSubtitleFetchCopy(copy.added, { name: entry.trackName }), dismissable: true });
    // Escape on the "added" panel only skips the wait: the subtitle is stored either way.
    if (await holdThenClose(mine)) deps.onAdded(entry);
  };

  // The "added" / "replaced" panel stays a moment (Escape skips the wait), then closes.
  const holdThenClose = async (mine: number) => {
    step = "added";
    const skip = Promise.withResolvers<void>();
    finishAdded = skip.resolve;
    await Promise.race([wait(deps.addedHoldMs ?? 1500), skip.promise]);
    finishAdded = null;
    if (mine !== run) return false;
    step = "idle";
    deps.show({ close: true });
    return true;
  };

  const version = async () => {
    const tryAnother = deps.tryAnother;
    if (!tryAnother) return;
    const mine = ++run;
    step = "busy";
    const controller = new AbortController();
    storing = controller;
    let outcome: Awaited<ReturnType<typeof tryAnother.run>>;
    try {
      outcome = await tryAnother.run((next) => {
        if (mine === run) deps.show({ panel: subtitleVersionLine(copy, next, tryAnother.name), dismissable: true });
      }, controller.signal);
    } finally {
      if (storing === controller) storing = null;
    }
    if (mine !== run || outcome === null) return;
    // None left, unavailable or failed: the line stays until Escape, which resumes.
    if (outcome !== "replaced") {
      step = "message";
      return;
    }
    if (await holdThenClose(mine)) deps.onReplaced?.();
  };

  const addFile = async () => {
    const adding = deps.addFile;
    if (!adding) return;
    const mine = ++run;
    step = "busy";
    let file: { name: string; content: string } | null = null;
    try {
      file = await adding.pick();
    } catch {
      file = null;
    }
    if (mine !== run) return;
    // The picker cancelled: nothing changed, playback resumes.
    if (!file) {
      step = "idle";
      return deps.onCancelled();
    }
    // Storing cannot be stopped half-way: no Escape until it ends.
    deps.show({ panel: copy.addingFile, dismissable: false });
    let stored: StoredSubtitleFile;
    try {
      stored = await adding.store(file);
    } catch (error) {
      if (mine === run) message(error instanceof UnreadableSubtitleFileError ? copy.unreadableFile : copy.fileFailed);
      return;
    }
    if (mine !== run) return;
    deps.show({ panel: fillSubtitleFetchCopy(copy.added, { name: stored.label }), dismissable: true });
    if (await holdThenClose(mine)) deps.onFileAdded?.(stored);
  };

  const cancel = () => {
    if (step === "idle") return;
    if (step === "added") return finishAdded?.();
    // Leaving while downloading or saving aborts the store: nothing is added (PLAY-SUBGET-02).
    storing?.abort();
    storing = null;
    run += 1;
    step = "idle";
    deps.show({ close: true });
    deps.onCancelled();
  };

  return {
    handle: (msg) => {
      if (msg.action === "open") void open();
      else if (msg.action === "version") void version();
      else if (msg.action === "add-file") void addFile();
      else if (msg.action === "pick") void pick(msg.key);
      else if (msg.action === "title") void findTitle(msg.text);
      else cancel();
    },
    dispose: () => {
      storing?.abort();
      storing = null;
      run += 1;
      step = "idle";
    },
  };
};
