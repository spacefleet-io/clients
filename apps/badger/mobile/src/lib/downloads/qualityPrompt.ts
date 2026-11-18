/**
 * The download quality prompt (OFFL-QUAL-01) as a one-at-a-time request:
 * `askDownloadQuality` is passed to `startDownload` as `chooseQuality`; the
 * one `DownloadQualitySheet` on the details page shows the pending request
 * and answers it. A new request dismisses an unanswered one. Pure — no React
 * Native; the hook is plain React.
 */
import { useSyncExternalStore } from "react";
import type { OfflineQualityChoice } from "@space/shared/offlineQualityChoice";

type Pending = { choices: OfflineQualityChoice[]; resolve: (quality: string | null) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export const askDownloadQuality = (choices: OfflineQualityChoice[]): Promise<string | null> =>
  new Promise((resolve) => {
    const previous = pending;
    pending = { choices, resolve };
    previous?.resolve(null);
    emit();
  });

/** Answer the pending request: the picked quality, or null when the prompt was dismissed. */
export const answerDownloadQuality = (quality: string | null): void => {
  const current = pending;
  if (!current) return;
  pending = null;
  emit();
  current.resolve(quality);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => pending?.choices ?? null;

/** The choices of the pending request, or null when nothing is being asked. */
export const useDownloadQualityRequest = (): OfflineQualityChoice[] | null =>
  useSyncExternalStore(subscribe, snapshot, snapshot);
