/**
 * The edit dialog's connected autocomplete list (PAR-META-18, draft B2): under the field being typed in, results that
 * fit the whole song or album ("Fits this song"), then those matching only the typed text ("Only “mete”"). The
 * library's come first in each, tagged "in your library"; dots show which fields a result fits. The library's answer
 * at once; while the lookup's are on their way a shimmer row says "Still asking…", never "nothing found" (PAR-META-20).
 * Keyboard and ARIA follow the search palette's combobox: the input keeps focus, ↑↓ move, Enter picks, Esc closes.
 */
import type { ReactNode } from "react";
import type { ParrotEditCover, ParrotEditSuggestion, ParrotEditSuggestQuery, ParrotEditSuggestions } from "@space/parrot-core";
import type { MusicSuggestField } from "@space/shared/api";
import { cn } from "../utils";
import { ParrotCover } from "./components";

/** Where the dialog's suggestions come from; `lookup` rejecting shows its reason in one line, the library's stay. */
export type ParrotEditSuggest = {
  /** The library's suggestions, instant. */
  library: (query: ParrotEditSuggestQuery) => ParrotEditSuggestion[];
  /** The metadata service's suggestions (asked after a short pause in typing). */
  lookup: (query: ParrotEditSuggestQuery) => Promise<ParrotEditSuggestion[]>;
  /** The cover of an album pick, by its `coverId`; null when none. */
  cover?: (coverId: string) => Promise<ParrotEditCover | null>;
  /** A library result's own cover (thumbnail address), drawn otherwise. */
  coverUrl?: (suggestion: ParrotEditSuggestion) => string | null;
};

export type ParrotEditSuggestLabels = {
  fits: string;
  fitsAlbum: string;
  only: (text: string) => string;
  inLibrary: string;
  stillAsking: string;
  trackOn: (title: string, number: number) => string;
  filledFrom: (name: string) => string;
  undo: string;
  restore: (value: string) => string;
  dots: (fields: string) => string;
  failed: (reason: string) => string;
};

export type ParrotEditSuggestLookup = { status: "asking" } | { status: "done" } | { status: "failed"; reason: string };

/** The field typed in, in music terms: the album dialog's title is the album's. */
export const suggestMusicField = (kind: "track" | "album", field: MusicSuggestField): MusicSuggestField => (kind === "album" && field === "title" ? "album" : field);

/** What a result shows as its name for the field typed in. */
export const suggestionName = (s: ParrotEditSuggestion, field: MusicSuggestField): string =>
  (field === "title" ? s.song?.title : field === "album" ? s.album?.title : s.artist.name) ?? s.album?.title ?? s.song?.title ?? s.artist.name;

/** The name a pick is "Filled in from": its album, else its song, else its artist. */
export const suggestionSource = (s: ParrotEditSuggestion): string => s.album?.title ?? s.song?.title ?? s.artist.name;

function Marked({ text, typed }: { text: string; typed: string }) {
  const at = typed ? text.toLocaleLowerCase().indexOf(typed.toLocaleLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary/20 text-inherit">{text.slice(at, at + typed.length)}</mark>
      {text.slice(at + typed.length)}
    </>
  );
}

export function ParrotEditSuggestList({
  id,
  kind,
  field,
  text,
  suggestions,
  lookup,
  active,
  labels,
  fieldLabels,
  coverUrl,
  onActive,
  onPick,
}: {
  id: string;
  kind: "track" | "album";
  field: MusicSuggestField;
  text: string;
  suggestions: ParrotEditSuggestions;
  lookup: ParrotEditSuggestLookup;
  active: number;
  labels: ParrotEditSuggestLabels;
  /** The dialog's field labels, named in the dots' description. */
  fieldLabels: { title: string; artist: string; album: string; albumArtist: string };
  coverUrl?: (suggestion: ParrotEditSuggestion) => string | null;
  onActive: (index: number) => void;
  onPick: (suggestion: ParrotEditSuggestion) => void;
}) {
  const music = suggestMusicField(kind, field);
  const typed = text.trim();
  // The album dialog has no song title: two dots, in its field order (album title, album artist).
  const dots: Array<[MusicSuggestField, string]> =
    kind === "album"
      ? [
          ["album", fieldLabels.title],
          ["artist", fieldLabels.albumArtist],
        ]
      : [
          ["title", fieldLabels.title],
          ["artist", fieldLabels.artist],
          ["album", fieldLabels.album],
        ];
  const row = (s: ParrotEditSuggestion, index: number): ReactNode => {
    const details = [
      music !== "artist" ? s.artist.name : null,
      s.album && music !== "album" ? s.album.title : null,
      s.album?.year ? String(s.album.year) : null,
      s.song && s.album?.trackNumber != null && music !== "title" ? labels.trackOn(s.song.title, s.album.trackNumber) : null,
    ].filter((part): part is string => Boolean(part));
    const fits = dots.filter(([f]) => s.fits[f]).map(([, label]) => label);
    const name = suggestionName(s, music);
    return (
      <li
        key={s.key}
        id={`${id}-${index}`}
        role="option"
        aria-selected={index === active}
        data-index={index}
        data-testid="manage-suggest-option"
        data-scope={s.scope}
        data-in-library={s.inLibrary}
        onMouseMove={() => onActive(index)}
        onClick={() => onPick(s)}
        // The B2 draft's selected row: a light green tint and edge, so its dots and "in your library" stay readable.
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-lg border px-2 py-1.5 text-foreground",
          index === active ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-card",
        )}
      >
        <span className={cn("size-9 shrink-0 overflow-hidden", s.kind === "artist" ? "rounded-full" : "rounded-md")}>
          <ParrotCover seed={s.key} label={name} src={coverUrl?.(s) ?? null} rounded={s.kind === "artist" ? "rounded-full" : undefined} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 truncate text-sm font-medium" data-testid="manage-suggest-name">
            <span className="truncate">
              <Marked text={name} typed={typed} />
            </span>
            {s.inLibrary ? (
              <span className="shrink-0 rounded bg-primary/15 px-1.5 text-[11px] font-normal text-primary" data-testid="manage-suggest-in-library">
                {labels.inLibrary}
              </span>
            ) : null}
          </span>
          {details.length ? (
            <span className="block truncate text-xs text-muted-foreground" data-testid="manage-suggest-details">
              {details.join(" · ")}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 gap-1" role="img" aria-label={labels.dots(fits.join(", "))} data-testid="manage-suggest-dots" data-fits={dots.map(([f]) => (s.fits[f] ? "1" : "0")).join("")}>
          {dots.map(([f]) => (
            <i key={f} className={cn("block size-1.5 rounded-full", s.fits[f] ? "bg-primary" : "bg-muted-foreground/30")} />
          ))}
        </span>
      </li>
    );
  };
  const section = (title: string, testId: string) => (
    <li role="presentation" className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-testid={testId}>
      {title}
      <span className="h-px flex-1 bg-border" />
    </li>
  );
  return (
    <ul
      id={id}
      role="listbox"
      data-testid="manage-suggest-list"
      data-lookup={lookup.status}
      // The input keeps focus: a click on a result picks it without blurring the field first.
      onMouseDown={(event) => event.preventDefault()}
      className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
    >
      {suggestions.all.length ? section(kind === "album" ? labels.fitsAlbum : labels.fits, "manage-suggest-fits") : null}
      {suggestions.all.map((s, i) => row(s, i))}
      {suggestions.field.length ? section(labels.only(typed), "manage-suggest-only") : null}
      {suggestions.field.map((s, i) => row(s, suggestions.all.length + i))}
      {lookup.status === "asking" ? (
        <li role="presentation" className="grid gap-1.5 px-2 py-2" aria-busy data-testid="manage-suggest-asking">
          <span className="text-xs text-muted-foreground">{labels.stillAsking}</span>
          <span className="block h-3 w-2/3 rounded bg-muted motion-safe:animate-pulse" aria-hidden />
        </li>
      ) : lookup.status === "failed" ? (
        <li role="presentation" className="px-2 py-2 text-xs text-destructive" data-testid="manage-suggest-failed">
          {labels.failed(lookup.reason)}
        </li>
      ) : null}
    </ul>
  );
}
