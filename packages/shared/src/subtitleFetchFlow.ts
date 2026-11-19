/**
 * The steps of "Get subtitles" (PLAY-SUBGET-01, -02, -05, -12, -18), one implementation for every Badger client
 * (REL-FAM-02): look first, then list only the languages that exist (nothing preselected), then say what is happening
 * while the picked subtitle is downloaded and stored, then say it was added. The web UI package draws it with DOM
 * elements (`SubtitleFetchFlow`, `@space/ui/badger/subtitle-fetch`), the phone with React Native views; both drive
 * these steps through `useSubtitleFetchFlow`, and the app injects the search and the storage.
 */
import type { SubtitleCredit } from "./api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildSubtitleEntries,
  fillSubtitleFetchCopy,
  nextSubtitleVersion,
  subtitleFetchCopy,
  subtitleFetchLabels,
  type FetchedSubtitleTrack,
  type SubtitleTitleMatch,
  type SubtitleFetchCandidate,
  type SubtitleFetchCopy,
  type SubtitleFetchEntry,
  type SubtitleFetchExistingTrack,
} from "./subtitleFetch";

/** `credit`: the line the subtitle source's terms ask for at the pick list, as the metadata service sends it (PLAY-SUBGET-25). */
export type SubtitleFetchSearchResult = { reachable: boolean; subtitles: SubtitleFetchCandidate[]; credit?: SubtitleCredit | null };
export type SubtitleFetchStage = "downloading" | "saving";

export type SubtitleFetchFlowState =
  /**
   * The media has no catalog id (PLAY-SUBGET-24): the user names the film or show. `matches` is null while the title
   * lookup runs, [] when nothing was found for `query`; picking a match runs the subtitle search for it.
   */
  | { step: "title"; query: string; matches: SubtitleTitleMatch[] | null }
  | { step: "looking" }
  | { step: "list"; entries: SubtitleFetchEntry[] }
  | { step: "none" }
  | { step: "unavailable" }
  | { step: "progress"; entry: SubtitleFetchEntry; stage: "getting" | SubtitleFetchStage; entries: SubtitleFetchEntry[] }
  | { step: "added"; entry: SubtitleFetchEntry }
  | { step: "failed"; entry: SubtitleFetchEntry; entries: SubtitleFetchEntry[] };

/** What a client draws: a flow step, or "offline" when the device has no connection (PLAY-SUBGET-12). */
export type SubtitleFetchFlowView = SubtitleFetchFlowState | { step: "offline" };

export type SubtitleFetchFlowInput = {
  uiLanguage: string;
  /** The library file's original name, for ranking (PLAY-SUBGET-14). Never sent anywhere. */
  libraryFileName?: string | null;
  /** The subtitles the movie or episode already has (PLAY-SUBGET-17, -18). */
  existingTracks: readonly SubtitleFetchExistingTrack[];
  /**
   * Every subtitle of this movie or episode, through the metadata service (PLAY-SUBGET-03). Rejects when unavailable.
   * `match` is the film or show the user picked by title when the media has no catalog id (`findTitle`).
   */
  search: (match?: SubtitleTitleMatch) => Promise<SubtitleFetchSearchResult>;
  /**
   * Set when the media has no catalog id (`subtitleFetchNeedsTitle`, PLAY-SUBGET-24): the flow starts by looking up
   * `query` (the title the app shows) with `find`, the metadata service's anonymous title lookup, and the user picks
   * the film or show (or types another title) before any subtitle search. Rejects when unavailable.
   */
  findTitle?: { query: string; find: (query: string) => Promise<SubtitleTitleMatch[]> };
  /**
   * Downloads `entry.best`, encrypts and stores it as `entry.trackName`, and remembers it (PLAY-SUBGET-19). `signal`
   * aborts when the flow is left mid-way (Back in the player, PLAY-SUBGET-02): nothing more is stored.
   */
  store: (entry: SubtitleFetchEntry, report: (stage: SubtitleFetchStage) => void, signal: AbortSignal) => Promise<void>;
};

/** The step a search result leads to: the list, "no subtitles", or the "working on it" message (PLAY-SUBGET-05, -12). */
export const subtitleFetchResultState = (
  result: SubtitleFetchSearchResult,
  input: Pick<SubtitleFetchFlowInput, "uiLanguage" | "libraryFileName" | "existingTracks">
): SubtitleFetchFlowState => {
  const entries = buildSubtitleEntries({
    candidates: result.subtitles,
    libraryFileName: input.libraryFileName,
    existingTracks: input.existingTracks,
    uiLanguage: input.uiLanguage,
    labels: subtitleFetchLabels(subtitleFetchCopy(input.uiLanguage)),
  });
  if (entries.length > 0) return { step: "list", entries };
  return { step: result.reachable ? "none" : "unavailable" };
};

/**
 * A subtitle the title already has is never downloaded again (PLAY-SUBGET-18, PLAY-SUBGET-24): its entry is listed,
 * marked, but not pickable; the stored one is picked in the player's subtitle menu.
 */
export const subtitleFetchEntryPickable = (entry: SubtitleFetchEntry) => entry.already === null;

/** The line of a progress step: "Getting French subtitles", "Downloading", "Saving to your media library". */
export const subtitleFetchProgressLine = (copy: SubtitleFetchCopy, entry: SubtitleFetchEntry, stage: "getting" | SubtitleFetchStage) =>
  stage === "getting"
    ? fillSubtitleFetchCopy(copy.getting, { language: entry.name })
    : stage === "downloading"
      ? copy.downloading
      : copy.saving;

export type SubtitleFetchFlowRunner = {
  /** Looks up every subtitle of the media; each search starts fresh (PLAY-SUBGET-05). */
  search: (match?: SubtitleTitleMatch) => Promise<void>;
  /** The media has no catalog id: looks `query` up (`findTitle`) and shows the matches to pick from. */
  findTitle: (query: string) => Promise<void>;
  /** Starts with the title lookup when the media needs one, else with the subtitle search. */
  start: () => Promise<void>;
  /** Stores the picked entry; resolves true once it was added. */
  pick: (entry: SubtitleFetchEntry, entries: SubtitleFetchEntry[]) => Promise<boolean>;
  /** Leaves the flow: a running store is aborted and no later step is reported. */
  dispose: () => void;
};

/**
 * The flow's steps without React, so they can be tested and driven by any client. `read` gives the current inputs;
 * `onCredit` gets the credit each search answer carries, null when it carries none (PLAY-SUBGET-25).
 */
export const createSubtitleFetchFlow = (
  read: () => SubtitleFetchFlowInput,
  onState: (state: SubtitleFetchFlowState) => void,
  onCredit?: (credit: SubtitleCredit | null) => void
): SubtitleFetchFlowRunner => {
  let disposed = false;
  let pickAbort: AbortController | null = null;
  const set = (state: SubtitleFetchFlowState) => {
    if (!disposed) onState(state);
  };
  let titleRun = 0;
  const search = async (match?: SubtitleTitleMatch) => {
    titleRun += 1;
    set({ step: "looking" });
    try {
      const result = await read().search(match);
      if (!disposed) onCredit?.(result.credit ?? null);
      set(subtitleFetchResultState(result, read()));
    } catch {
      set({ step: "unavailable" });
    }
  };
  const findTitle = async (query: string) => {
    const finder = read().findTitle;
    if (!finder) return search();
    const run = (titleRun += 1);
    const trimmed = query.trim();
    set({ step: "title", query: trimmed, matches: trimmed ? null : [] });
    if (!trimmed) return;
    try {
      const matches = await finder.find(trimmed);
      if (run === titleRun) set({ step: "title", query: trimmed, matches });
    } catch {
      if (run === titleRun) set({ step: "unavailable" });
    }
  };
  return {
    search,
    findTitle,
    start: () => {
      const finder = read().findTitle;
      return finder ? findTitle(finder.query) : search();
    },
    pick: async (entry, entries) => {
      if (disposed || !subtitleFetchEntryPickable(entry)) return false;
      pickAbort?.abort();
      const abort = new AbortController();
      pickAbort = abort;
      set({ step: "progress", entry, stage: "getting", entries });
      try {
        await read().store(entry, (stage) => {
          if (!abort.signal.aborted) set({ step: "progress", entry, stage, entries });
        }, abort.signal);
        if (abort.signal.aborted) return false;
        set({ step: "added", entry });
        return true;
      } catch {
        if (!abort.signal.aborted) set({ step: "failed", entry, entries });
        return false;
      }
    },
    dispose: () => {
      disposed = true;
      pickAbort?.abort();
    },
  };
};

/** Where "Try another version" is (PLAY-SUBGET-07): a step while it runs, then how it ended. */
export type SubtitleVersionStep = "looking" | SubtitleFetchStage | "replaced" | "none-left" | "unavailable" | "failed";

export type TryAnotherSubtitleVersionInput = {
  uiLanguage: string;
  libraryFileName?: string | null;
  /** The fetched subtitle to replace. */
  track: FetchedSubtitleTrack;
  /** Every subtitle of this movie or episode, through the metadata service and its cache (PLAY-SUBGET-03, -09). */
  search: () => Promise<SubtitleFetchSearchResult>;
  /** Downloads `file`, stores it in place of `track` and remembers it (`replaceFetchedSubtitle`). */
  replace: (file: SubtitleFetchCandidate, report: (stage: SubtitleFetchStage) => void, signal: AbortSignal) => Promise<void>;
};

/**
 * "Try another version" from the player (PLAY-SUBGET-07), one implementation for every Badger client: look the
 * subtitles up again, take the file after the one the track holds in its entry's ranked list, and put it in place of
 * the track. Reports each step; resolves with how it ended, or null when `signal` aborted (Back: nothing changed).
 */
export const tryAnotherSubtitleVersion = async (
  input: TryAnotherSubtitleVersionInput,
  report: (step: SubtitleVersionStep) => void,
  signal: AbortSignal
): Promise<"replaced" | "none-left" | "unavailable" | "failed" | null> => {
  const end = (step: "replaced" | "none-left" | "unavailable" | "failed") => {
    if (signal.aborted) return null;
    report(step);
    return step;
  };
  report("looking");
  let result: SubtitleFetchSearchResult;
  try {
    result = await input.search();
  } catch {
    return end("unavailable");
  }
  if (signal.aborted) return null;
  const labels = subtitleFetchLabels(subtitleFetchCopy(input.uiLanguage));
  const entries = buildSubtitleEntries({
    candidates: result.subtitles,
    libraryFileName: input.libraryFileName,
    uiLanguage: input.uiLanguage,
    labels,
  });
  const next = nextSubtitleVersion(entries, input.track, labels);
  if (!next) return end(result.reachable ? "none-left" : "unavailable");
  try {
    await input.replace(next.file, (stage) => {
      if (!signal.aborted) report(stage);
    }, signal);
  } catch {
    return end("failed");
  }
  return end("replaced");
};

/** The line a client shows for a "Try another version" step, naming the subtitle ("Spanish"). */
export const subtitleVersionLine = (copy: SubtitleFetchCopy, step: SubtitleVersionStep, name: string) => {
  const lines: Record<SubtitleVersionStep, string> = {
    looking: copy.lookingAnother,
    downloading: copy.downloading,
    saving: copy.saving,
    replaced: copy.replaced,
    "none-left": copy.noneLeft,
    unavailable: copy.unavailable,
    failed: copy.replaceFailed,
  };
  return fillSubtitleFetchCopy(lines[step], { name });
};

export type UseSubtitleFetchFlowOptions = SubtitleFetchFlowInput & {
  /** The device has no connection: nothing is searched (PLAY-SUBGET-12). */
  offline?: boolean;
  /** The subtitle was stored and the "added" message shown. */
  onAdded?: (entry: SubtitleFetchEntry) => void;
  /** Back / Done: leave the flow (the player resumes, PLAY-SUBGET-02). */
  onClose: () => void;
  /** How long "added" shows before `onAdded` + `onClose` run by themselves; omit to wait for Done. */
  autoCloseAfterAddedMs?: number;
};

export type SubtitleFetchFlowHandle = {
  view: SubtitleFetchFlowView;
  copy: SubtitleFetchCopy;
  pick: (entry: SubtitleFetchEntry, entries: SubtitleFetchEntry[]) => void;
  /** The "title" step: look up another title the user typed. */
  findTitle: (query: string) => void;
  /** The "title" step: search subtitles for the film or show the user picked. */
  pickTitle: (match: SubtitleTitleMatch) => void;
  /** Done on the "added" step: `onAdded`, then `onClose`. */
  done: () => void;
  /** Shown with the pick list, `text` then `name` linked to `url` (PLAY-SUBGET-25); null when the service sent none. */
  credit: SubtitleCredit | null;
};

/**
 * The flow for one mounted panel: searches once on mount (and again when the connection comes back), then follows the
 * user's pick. Unmounting abandons a running download or save.
 */
export function useSubtitleFetchFlow(options: UseSubtitleFetchFlowOptions): SubtitleFetchFlowHandle {
  const { offline = false, uiLanguage, autoCloseAfterAddedMs } = options;
  const copy = subtitleFetchCopy(uiLanguage);
  const [state, setState] = useState<SubtitleFetchFlowState>({ step: "looking" });
  const [credit, setCredit] = useState<SubtitleCredit | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const flowRef = useRef<SubtitleFetchFlowRunner | null>(null);

  useEffect(() => {
    if (offline) return;
    const flow = createSubtitleFetchFlow(() => optionsRef.current, setState, setCredit);
    flowRef.current = flow;
    void flow.start();
    return () => {
      flow.dispose();
      if (flowRef.current === flow) flowRef.current = null;
    };
  }, [offline]);

  const addedEntry = state.step === "added" ? state.entry : null;
  useEffect(() => {
    if (!addedEntry || autoCloseAfterAddedMs === undefined) return;
    const timer = setTimeout(() => {
      optionsRef.current.onAdded?.(addedEntry);
      optionsRef.current.onClose();
    }, autoCloseAfterAddedMs);
    return () => clearTimeout(timer);
  }, [addedEntry, autoCloseAfterAddedMs]);

  const pick = useCallback((entry: SubtitleFetchEntry, entries: SubtitleFetchEntry[]) => {
    void flowRef.current?.pick(entry, entries);
  }, []);

  const findTitle = useCallback((query: string) => {
    void flowRef.current?.findTitle(query);
  }, []);

  const pickTitle = useCallback((match: SubtitleTitleMatch) => {
    void flowRef.current?.search(match);
  }, []);

  const done = useCallback(() => {
    if (addedEntry) optionsRef.current.onAdded?.(addedEntry);
    optionsRef.current.onClose();
  }, [addedEntry]);

  return { view: offline ? { step: "offline" } : state, copy, pick, findTitle, pickTitle, done, credit };
}
