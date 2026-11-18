/**
 * Download scopes (movie / show / season / episode) and the file ids they
 * cover. Mirrors `apps/badger/desktop/src/renderer/src/lib/offlineEstimator.ts`
 * (`OfflineScope`, `inScopeFileIds`) so both clients cut the library the same
 * way; the desktop copy is renderer-private so it cannot be imported here.
 *
 * Pure — no React, no native modules.
 */
import type { MediaDetails } from "@space/shared/libraryTypes";

export type OfflineScope =
  | { kind: "movie" }
  | { kind: "show" }
  | { kind: "season"; seasonNumber: number }
  | { kind: "episode"; seasonNumber: number; episodeNumber: number };

/** File ids (`media_files.id`) covered by `scope`, in library order. */
export const inScopeFileIds = (
  details: Pick<MediaDetails, "files">,
  scope: OfflineScope,
): string[] => {
  const out: string[] = [];
  for (const file of details.files) {
    const isEpisodeFile = file.season != null && file.episode != null;
    switch (scope.kind) {
      case "movie":
        if (!isEpisodeFile) out.push(file.id);
        break;
      case "episode":
        if (file.season === scope.seasonNumber && file.episode === scope.episodeNumber) out.push(file.id);
        break;
      case "season":
        if (isEpisodeFile && file.season === scope.seasonNumber) out.push(file.id);
        break;
      case "show":
        if (isEpisodeFile) out.push(file.id);
        break;
    }
  }
  // Episodes ordered season/episode so the queue downloads in watch order.
  if (scope.kind === "season" || scope.kind === "show") {
    const order = new Map(
      details.files.map((f) => [f.id, (f.season ?? 0) * 100000 + (f.episode ?? 0)] as const),
    );
    out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return out;
};

/** `media_files.id` of one episode, or null when it has no playable file. */
export const fileIdForEpisode = (
  details: Pick<MediaDetails, "files">,
  seasonNumber: number,
  episodeNumber: number,
): string | null =>
  details.files.find((f) => f.season === seasonNumber && f.episode === episodeNumber)?.id ?? null;
