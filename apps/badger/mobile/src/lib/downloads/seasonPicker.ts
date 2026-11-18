/**
 * Season picker behind a show's download button: one checkbox per season that
 * has playable files. A box starts ticked when the whole season is already
 * offline or on its way; applying downloads newly ticked seasons and removes
 * the downloads of seasons the user unticked. Seasons with only some episodes
 * saved start unticked, so per-episode choices are never widened or wiped
 * just by opening and confirming the picker.
 *
 * Pure — no React, no native modules.
 */
import type { MediaDetails } from "@space/shared/libraryTypes";
import type { DownloadItem } from "@space/mobile-media-proxy/downloads";
import { derivePillState, isActiveStatus, type PillState } from "./decisions";
import { inScopeFileIds } from "./scope";

export type SeasonPickerRow = {
  seasonNumber: number;
  fileIds: string[];
  state: PillState;
  /** Whole season offline, or every one of its episodes queued/downloading. */
  initiallyChecked: boolean;
};

export type SeasonPickerChanges = {
  /** Seasons to download (missing episodes only; the planner skips saved ones). */
  add: number[];
  /** Download ids to delete, from seasons that were unticked. */
  removeIds: string[];
};

/** Seasons in ascending order; season 0 ("Specials") last so it never leads the list. */
const seasonOrder = (a: number, b: number): number => (a === 0 ? 1 : b === 0 ? -1 : a - b);

export const seasonPickerRows = (
  details: Pick<MediaDetails, "files">,
  itemsById: ReadonlyMap<string, DownloadItem>,
  net: { networkAllowed: boolean; wifiOnly: boolean },
): SeasonPickerRow[] => {
  const seasons = new Set<number>();
  for (const file of details.files) {
    if (file.season != null && file.episode != null) seasons.add(file.season);
  }
  return [...seasons].sort(seasonOrder).map((seasonNumber) => {
    const fileIds = inScopeFileIds(details, { kind: "season", seasonNumber });
    const state = derivePillState(fileIds, itemsById, net);
    const wholeSeasonTracked = fileIds.every((id) => {
      const item = itemsById.get(id);
      return item !== undefined && (item.status === "completed" || isActiveStatus(item.status));
    });
    return { seasonNumber, fileIds, state, initiallyChecked: wholeSeasonTracked };
  });
};

export const seasonPickerChanges = (
  rows: ReadonlyArray<SeasonPickerRow>,
  checked: ReadonlySet<number>,
  itemsById: ReadonlyMap<string, DownloadItem>,
): SeasonPickerChanges => {
  const add: number[] = [];
  const removeIds: string[] = [];
  for (const row of rows) {
    const isChecked = checked.has(row.seasonNumber);
    if (isChecked && !row.initiallyChecked) add.push(row.seasonNumber);
    if (!isChecked && row.initiallyChecked) {
      for (const id of row.fileIds) if (itemsById.has(id)) removeIds.push(id);
    }
  }
  return { add, removeIds };
};

/** Seasons whose every episode is saved on this device (the season chip stamp). */
export const downloadedSeasonNumbers = (rows: ReadonlyArray<SeasonPickerRow>): Set<number> =>
  new Set(rows.filter((r) => r.state.kind === "downloaded").map((r) => r.seasonNumber));
