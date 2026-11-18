import * as React from "react";
import type { MediaRow } from "@space/shared/libraryTypes";
import { searchPaletteStrings } from "@space/shared/searchPaletteStrings";

import { SearchPalette, type SearchPaletteItem } from "../search-palette";

/**
 * Badger's search palette (UX-SEARCH-01), shared by the desktop app and the web player: every movie and show of the
 * library, searched by title and by the people in it; Enter opens the title's page.
 */

export type BadgerSearchMedia = Pick<MediaRow, "id" | "type" | "title" | "year" | "posterPath">;

export type BadgerSearchPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: readonly BadgerSearchMedia[];
  /** Names of the people in a title (cast), when the app has its details. */
  peopleOf?: (id: string) => readonly string[] | undefined;
  /** The app's UI language code. */
  language: string | undefined;
  onOpenTitle: (id: string) => void;
  /** Draws a poster from its `posterPath`. */
  renderPoster?: (posterPath: string, title: string) => React.ReactNode;
};

export function BadgerSearchPalette({ open, onOpenChange, media, peopleOf, language, onOpenTitle, renderPoster }: BadgerSearchPaletteProps) {
  const labels = React.useMemo(() => searchPaletteStrings("badger", language), [language]);
  // Built only while open, so cast lookups never run in the background.
  const items = React.useMemo<SearchPaletteItem[]>(
    () =>
      open
        ? media.map((m) => ({
            key: m.id,
            kind: m.type,
            title: m.title,
            subtitle: [m.year, labels.kinds[m.type]].filter(Boolean).join(" · "),
            image: m.posterPath,
            keywords: peopleOf?.(m.id) ?? [],
          }))
        : [],
    [open, media, peopleOf, labels],
  );
  return (
    <SearchPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      labels={labels}
      onSelect={(item) => onOpenTitle(item.key)}
      renderImage={renderPoster ? (item) => renderPoster(item.image!, item.title) : undefined}
    />
  );
}
