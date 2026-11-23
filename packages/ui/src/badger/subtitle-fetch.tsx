import * as React from "react";
import { Check } from "lucide-react";
import type { SubtitleCredit } from "@space/shared/api";
import { fillSubtitleFetchCopy, type SubtitleFetchCopy, type SubtitleFetchEntry, type SubtitleFetchExistingTrack } from "@space/shared/subtitleFetch";
import {
  subtitleFetchEntryPickable,
  subtitleFetchProgressLine,
  useSubtitleFetchFlow,
  type SubtitleFetchSearchResult,
  type SubtitleFetchStage,
} from "@space/shared/subtitleFetchFlow";

import { Button } from "../button";
import { Spinner } from "../spinner";
import { cn } from "../utils";
import type { PlayerChromeMenuItem } from "./PlayerChrome";

/**
 * "Get subtitles" (PLAY-SUBGET-01, -02, -05): the one flow every Badger client shows, from the media's subtitles tab
 * (inside a dialog) and from the player's subtitle menu (over the paused video). Looks first, then lists only the
 * languages that exist, by name only and with nothing preselected, then says what is happening while the picked
 * subtitle is downloaded and stored, then says it was added. The app injects the search and the storage, so the
 * flow is the same whatever the platform stores with.
 *
 * The copy comes from `@space/shared/subtitleFetch` (`subtitleFetchCopy`), shared with every client.
 */

export type { SubtitleFetchSearchResult, SubtitleFetchStage };

export type SubtitleFetchFlowProps = {
  uiLanguage: string;
  /** The library file's original name, for ranking (PLAY-SUBGET-14). Never sent anywhere. */
  libraryFileName?: string | null;
  /** The subtitles the movie or episode already has (PLAY-SUBGET-17, -18). */
  existingTracks: readonly SubtitleFetchExistingTrack[];
  /** The device has no connection: nothing is searched (PLAY-SUBGET-12). */
  offline?: boolean;
  /** Every subtitle of this movie or episode, through the metadata service (PLAY-SUBGET-03). Rejects when unavailable. */
  search: () => Promise<SubtitleFetchSearchResult>;
  /** Downloads `entry.best`, encrypts and stores it as `entry.trackName`, and remembers it (PLAY-SUBGET-19). */
  store: (entry: SubtitleFetchEntry, report: (stage: SubtitleFetchStage) => void, signal: AbortSignal) => Promise<void>;
  /** The subtitle was stored and the "added" message shown. */
  onAdded?: (entry: SubtitleFetchEntry) => void;
  /** Back / Done: leave the flow (the player resumes, PLAY-SUBGET-02). */
  onClose: () => void;
  /** How long "added" shows before `onAdded` + `onClose` run by themselves; omit to wait for Done. */
  autoCloseAfterAddedMs?: number;
  className?: string;
};

/** The steps live in `useSubtitleFetchFlow` (`@space/shared/subtitleFetchFlow`), shared with the phone's sheet. */
export function SubtitleFetchFlow({ className, onClose, autoCloseAfterAddedMs, ...options }: SubtitleFetchFlowProps) {
  const { view: state, copy, pick, done, credit } = useSubtitleFetchFlow({ ...options, onClose, autoCloseAfterAddedMs });
  const offline = state.step === "offline";

  const back = (
    <Button variant="outline" onClick={onClose} data-testid="subtitle-fetch-back">
      {copy.back}
    </Button>
  );

  let body: React.ReactNode;
  if (offline) {
    body = (
      <>
        <p className="text-sm text-muted-foreground" data-testid="subtitle-fetch-offline">
          {copy.offline}
        </p>
        <div className="flex justify-end">{back}</div>
      </>
    );
  } else if (state.step === "looking") {
    body = (
      <div className="flex items-center gap-3 py-6" data-testid="subtitle-fetch-looking">
        <Spinner size="lg" aria-label={copy.looking} />
        <span>{copy.looking}</span>
      </div>
    );
  } else if (state.step === "none" || state.step === "unavailable") {
    body = (
      <>
        <p className="text-sm" data-testid={`subtitle-fetch-${state.step}`}>
          {state.step === "none" ? copy.none : copy.unavailable}
        </p>
        <div className="flex justify-end">{back}</div>
      </>
    );
  } else if (state.step === "list" || state.step === "failed") {
    const entries = state.entries;
    body = (
      <>
        {state.step === "failed" ? (
          <p className="text-sm text-destructive" role="alert" data-testid="subtitle-fetch-failed">
            {fillSubtitleFetchCopy(copy.failed, { name: state.entry.name })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{copy.pick}</p>
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto" data-testid="subtitle-fetch-list">
          {entries.map((entry) => {
            // A subtitle fetched before is never fetched a second time (PLAY-SUBGET-18).
            const disabled = !subtitleFetchEntryPickable(entry);
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(entry, entries)}
                  data-testid="subtitle-fetch-entry"
                  data-language={entry.languageTag}
                  className="flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className="font-medium">{entry.name}</span>
                  {entry.already ? (
                    <span className="text-xs text-muted-foreground" data-testid="subtitle-fetch-already">
                      {copy.already}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {credit ? <SubtitleFetchCredit credit={credit} /> : null}
        <div className="flex justify-end">{back}</div>
      </>
    );
  } else if (state.step === "progress") {
    const line = subtitleFetchProgressLine(copy, state.entry, state.stage);
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="subtitle-fetch-progress" data-stage={state.stage}>
        <Spinner size="lg" aria-label={line} />
        <span>{line}</span>
      </div>
    );
  } else {
    body = (
      <>
        <div className="flex items-center justify-center gap-2 py-6" data-testid="subtitle-fetch-added">
          <Check className="h-5 w-5 text-primary" aria-hidden />
          <span>{fillSubtitleFetchCopy(copy.added, { name: state.entry.trackName })}</span>
        </div>
        {autoCloseAfterAddedMs === undefined ? (
          <div className="flex justify-end">
            <Button
              onClick={done}
              data-testid="subtitle-fetch-done"
            >
              {copy.done}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="subtitle-fetch" data-step={state.step}>
      {body}
    </div>
  );
}

/** The credit the subtitle source's terms ask for at the pick list, as the metadata service sent it (PLAY-SUBGET-25). */
export function SubtitleFetchCredit({ credit }: { credit: SubtitleCredit }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="subtitle-fetch-credit">
      {credit.text}{" "}
      <a href={credit.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
        {credit.name}
      </a>
    </p>
  );
}

/** The ids of the subtitle menu's command rows. */
export const PLAYER_SUBTITLE_GET_MORE = "get-more";
export const PLAYER_SUBTITLE_TRY_ANOTHER = "try-another";

/**
 * The subtitle menu's last rows (PLAY-SUBGET-02, -07): "Try another version" when the subtitle on is a fetched one,
 * then "Get more subtitles…", unavailable offline with the reason under it.
 */
export const playerSubtitleMenuActions = (
  copy: SubtitleFetchCopy,
  { canGet, online, selectedFetched }: { canGet: boolean; online: boolean; selectedFetched: boolean }
): PlayerChromeMenuItem[] => {
  if (!canGet) return [];
  const offline = online ? undefined : copy.offline;
  return [
    ...(selectedFetched ? [{ id: PLAYER_SUBTITLE_TRY_ANOTHER, label: copy.tryAnother, selected: false, action: true, disabled: !online, detail: offline }] : []),
    { id: PLAYER_SUBTITLE_GET_MORE, label: copy.getMore, selected: false, action: true, disabled: !online, detail: offline },
  ];
};

/**
 * A card over the paused video, inside the player's frame so it stays on screen in full screen: the "Get subtitles"
 * flow and the "Try another version" lines show in it.
 */
export function PlayerSubtitlePanel({ children, testId, label }: { children: React.ReactNode; testId: string; label: string }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/50 p-6" data-testid={`${testId}-backdrop`}>
      <div role="dialog" aria-label={label} className="w-full max-w-md rounded-2xl bg-card p-5 text-card-foreground shadow-2xl" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

/**
 * One line over the paused video (PLAY-SUBGET-07, -12): a spinner while something runs, and one button — Back while
 * running (nothing changes), Done once it ended.
 */
export function PlayerSubtitleStatus({ line, busy, button, onButton, testId }: { line: string; busy: boolean; button: string; onButton: () => void; testId: string }) {
  return (
    <PlayerSubtitlePanel testId={testId} label={line}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3" role="status" data-testid={`${testId}-line`} data-busy={busy ? "true" : "false"}>
          {busy ? <Spinner size="lg" aria-label={line} /> : null}
          <span>{line}</span>
        </div>
        <div className="flex justify-end">
          <Button variant={busy ? "outline" : "default"} onClick={onButton} autoFocus data-testid={`${testId}-button`}>
            {button}
          </Button>
        </div>
      </div>
    </PlayerSubtitlePanel>
  );
}

/** Tracks the device's connection, so "Get subtitles" greys out offline and comes back by itself (PLAY-SUBGET-12). */
export function useOnline(): boolean {
  const [online, setOnline] = React.useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
