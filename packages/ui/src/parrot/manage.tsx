/**
 * Managing the music library (PAR-LIB-03, PAR-LIB-04): the edit-details dialog every Parrot app opens for a song or
 * an album. Every field that names something autocompletes, the fields together (PAR-META-18, draft B2): picking a
 * result fills every field it knows, each changed one shows what it was with a ↺ to put it back, and a note offers to
 * undo the whole pick; nothing is saved until Save. The Lyrics section (PAR-LYR-05) looks the lyrics up as it opens
 * when the song never was. While something is being looked up it shimmers; once the lookup came back empty it says so
 * (PAR-META-20).
 */
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ImagePlus, RotateCcw, RotateCw } from "lucide-react";
import { Button } from "../button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { Input } from "../input";
import { cn } from "../utils";
import { ParrotCover } from "./components";
import {
  applyParrotEditSuggestion,
  mergeParrotEditSuggestions,
  parrotEditFieldChanged,
  parrotEditNumber as numberOrNull,
  type ParrotEditAlbumLyricsState,
  type ParrotEditFields,
  type ParrotEditLyricsState,
  type ParrotEditSuggestion,
} from "@space/parrot-core";
import type { MusicSuggestField } from "@space/shared/api";
import {
  ParrotEditSuggestList,
  suggestionSource,
  type ParrotEditSuggest,
  type ParrotEditSuggestLabels,
  type ParrotEditSuggestLookup,
} from "./editSuggest";

export type { ParrotEditSuggest, ParrotEditSuggestLabels } from "./editSuggest";
// PAR-UP-08: the import review's artist field shows the same list.
export { ParrotEditSuggestList, suggestionName } from "./editSuggest";

/** The dialog's Lyrics section (PAR-LYR-05): a song's words, or how many of an album's songs have some. */
export type ParrotEditLyrics =
  | { kind: "track"; state: ParrotEditLyricsState; onSearchAgain: () => void }
  | { kind: "album"; state: ParrotEditAlbumLyricsState; onSearchMissing: () => void };

export type ParrotEditLyricsLabels = {
  lyrics: string;
  lyricsSearching: string;
  lyricsNone: string;
  lyricsSearchAgain: string;
  lyricsFailed: (reason: string) => string;
  albumLyrics: (found: number, count: number) => string;
  albumLyricsSearch: string;
};

/** A shimmering line standing for text still on its way (PAR-META-20). */
function Shimmer({ className }: { className?: string }) {
  return <span className={cn("block h-3 rounded bg-muted motion-safe:animate-pulse", className)} aria-hidden />;
}

function LyricsSection({ lyrics, labels }: { lyrics: ParrotEditLyrics; labels: ParrotEditLyricsLabels }) {
  const state = lyrics.state;
  const again = (label: string, onClick: () => void) => (
    <Button type="button" variant="ghost" size="sm" className="justify-start px-0" onClick={onClick} data-testid="manage-lyrics-search">
      <RotateCw className="size-4" /> {label}
    </Button>
  );
  let body;
  if (state.status === "loading")
    body = (
      <div className="grid gap-2" aria-busy data-testid="manage-lyrics-loading">
        <span className="text-xs text-muted-foreground">{labels.lyricsSearching}</span>
        <Shimmer className="w-3/4" />
        <Shimmer className="w-1/2" />
      </div>
    );
  else if (state.status === "found")
    body = (
      <div className="grid gap-0.5 text-sm" data-testid="manage-lyrics-found" data-synced={state.synced}>
        {state.preview.map((line, i) => (
          <span key={i} className="truncate">
            {line}
          </span>
        ))}
      </div>
    );
  else if (state.status === "counted" && lyrics.kind === "album")
    body = (
      <div className="grid gap-1 text-sm" data-testid="manage-lyrics-counted" data-found={state.found} data-count={state.count}>
        <span>{labels.albumLyrics(state.found, state.count)}</span>
        {state.missing > 0 ? again(labels.albumLyricsSearch, lyrics.onSearchMissing) : null}
      </div>
    );
  else if (lyrics.kind === "track")
    body = (
      <div className="grid gap-1 text-sm" data-testid={state.status === "failed" ? "manage-lyrics-failed" : "manage-lyrics-none"}>
        <span className={state.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
          {state.status === "failed" ? labels.lyricsFailed(state.reason) : labels.lyricsNone}
        </span>
        {again(labels.lyricsSearchAgain, lyrics.onSearchAgain)}
      </div>
    );
  return (
    <section className="grid gap-1.5 rounded-lg border border-border p-3" data-testid="manage-lyrics" data-state={state.status}>
      <span className="text-sm text-muted-foreground">{labels.lyrics}</span>
      {body}
    </section>
  );
}

export type { ParrotEditFields } from "@space/parrot-core";

/** A cover the user dropped, picked or pasted; a found cover arrives as bytes too. */
export type ParrotCoverInput = { kind: "file"; bytes: Uint8Array; mime: string } | { kind: "url"; url: string };

export type ParrotEditLabels = {
  title: string;
  body?: string;
  cancel: string;
  submit: string;
  changed: string;
  field: { title: string; artist: string; album: string; albumArtist: string; number: string; disc: string; year: string; genre: string; cover: string };
  coverHint: string;
  coverPick: string;
};

const isImageUrl = (text: string) => /^https?:\/\/\S+$/i.test(text.trim());

/** Wait after the last keystroke before the lookup is asked (the library answers at once). */
const LOOKUP_PAUSE_MS = 250;

type TextKey = "title" | "artist" | "album" | "number" | "disc" | "year" | "genre";
type Texts = Record<TextKey, string>;
/** The open autocomplete list: the field typed in, what is typed, the library's answer and the lookup's. */
type SuggestState = { field: MusicSuggestField; text: string; library: ParrotEditSuggestion[]; lookup: ParrotEditSuggestLookup; found: ParrotEditSuggestion[] };
/** A pick filled the form: what the fields (and cover) held before it, for ↺ and Undo. */
type Filled = { name: string; before: Texts; cover: ParrotCoverInput | null };

const textsOf = (values: ParrotEditFields): Texts => ({
  title: values.title,
  artist: values.artist,
  album: values.album ?? "",
  number: values.number ? String(values.number) : "",
  disc: String(values.disc ?? 1),
  year: values.year ? String(values.year) : "",
  genre: values.genre ?? "",
});

export function ParrotEditMetadataDialog({
  open,
  onOpenChange,
  kind,
  initial,
  current,
  coverUrl,
  initialCover = null,
  labels,
  error,
  busy = false,
  suggest,
  suggestLabels,
  lyrics,
  lyricsLabels,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "track" | "album";
  /** The values the form opens with. */
  initial: ParrotEditFields;
  /** The library's values: fields that differ from them are marked as changed. */
  current?: ParrotEditFields;
  coverUrl?: string | null;
  initialCover?: ParrotCoverInput | null;
  labels: ParrotEditLabels;
  error?: string | null;
  busy?: boolean;
  /** The connected autocomplete (PAR-META-18); shown with `suggestLabels`. */
  suggest?: ParrotEditSuggest;
  suggestLabels?: ParrotEditSuggestLabels;
  /** The Lyrics section (PAR-LYR-05); shown with `lyricsLabels`. */
  lyrics?: ParrotEditLyrics;
  lyricsLabels?: ParrotEditLyricsLabels;
  onSubmit: (fields: ParrotEditFields, cover: ParrotCoverInput | null) => void;
}) {
  const [texts, setTexts] = useState<Texts>(() => textsOf(initial));
  const [cover, setCover] = useState<ParrotCoverInput | null>(initialCover);
  const [preview, setPreview] = useState<string | null>(null);
  const [list, setList] = useState<SuggestState | null>(null);
  const [active, setActive] = useState(0);
  const [filled, setFilled] = useState<Filled | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Each keystroke and pick bumps it, so a lookup or a cover answering late is dropped.
  const asked = useRef(0);
  // What each field held before the user typed a query into it: a pick strikes that in the field typed in, not the
  // half-typed "mete" (draft B2: "Live in Texas → Meteora").
  const typedFrom = useRef<Partial<Texts>>({});
  const listId = useId();

  const stopAsking = () => {
    asked.current += 1;
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
  };
  useEffect(() => stopAsking, []);

  useEffect(() => {
    if (!open) return;
    stopAsking();
    setTexts(textsOf(initial));
    setCover(initialCover);
    setList(null);
    setFilled(null);
    typedFrom.current = {};
  }, [open, initial, initialCover]);

  useEffect(() => {
    if (!cover) return setPreview(null);
    if (cover.kind === "url") return setPreview(cover.url);
    const url = URL.createObjectURL(new Blob([new Uint8Array(cover.bytes)], { type: cover.mime }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  const takeFile = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    setCover({ kind: "file", bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const url = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (event.dataTransfer.files.length) void takeFile(event.dataTransfer.files[0]);
    else if (isImageUrl(url)) setCover({ kind: "url", url: url.trim() });
  };
  const onPaste = (event: ClipboardEvent) => {
    const file = [...event.clipboardData.files].find((f) => f.type.startsWith("image/"));
    const text = event.clipboardData.getData("text/plain");
    if (file) {
      event.preventDefault();
      void takeFile(file);
    } else if (isImageUrl(text)) {
      event.preventDefault();
      setCover({ kind: "url", url: text.trim() });
    }
  };

  const fieldsOf = (t: Texts): ParrotEditFields => ({
    title: t.title.trim(),
    artist: t.artist.trim(),
    ...(kind === "track" ? { album: t.album.trim(), number: numberOrNull(t.number), disc: numberOrNull(t.disc) ?? 1 } : {}),
    year: numberOrNull(t.year),
    genre: t.genre.trim() || null,
  });
  const fields = fieldsOf(texts);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!fields.title || busy) return;
    onSubmit(fields, cover);
  };
  const changed = (key: keyof ParrotEditFields) => parrotEditFieldChanged(fields, current, key);

  /** Opens the list for what is typed in `field`: the library's results now, the lookup's after a pause. */
  const ask = (field: MusicSuggestField, next: Texts) => {
    stopAsking();
    setActive(0);
    const text = next[field];
    if (!suggest || text.trim() === "") return setList(null);
    const query = { kind, field, text, fields: { title: next.title, artist: next.artist, ...(kind === "track" ? { album: next.album } : {}) } };
    const id = asked.current;
    setList({ field, text, library: suggest.library(query), lookup: { status: "asking" }, found: [] });
    timer.current = setTimeout(() => {
      timer.current = null;
      suggest.lookup(query).then(
        (found) => id === asked.current && setList((open) => open && { ...open, lookup: { status: "done" }, found }),
        (reason: unknown) => id === asked.current && setList((open) => open && { ...open, lookup: { status: "failed", reason: reason instanceof Error ? reason.message : String(reason) } }),
      );
    }, LOOKUP_PAUSE_MS);
  };
  const closeList = () => {
    stopAsking();
    setList(null);
  };
  const shown = list ? mergeParrotEditSuggestions(list.library, list.found, { kind, values: initial }) : null;
  const options = shown ? [...shown.all, ...shown.field] : [];

  const pick = (s: ParrotEditSuggestion) => {
    closeList();
    const next = textsOf(applyParrotEditSuggestion(kind, fields, s));
    // A second pick still undoes to what the fields held before the first.
    const typed = list ? typedFrom.current[list.field] : undefined;
    const before = filled ?? { before: list && typed !== undefined ? { ...texts, [list.field]: typed } : texts, cover };
    typedFrom.current = {};
    setTexts({ ...next, genre: texts.genre });
    setFilled({ name: suggestionSource(s), before: before.before, cover: before.cover });
    const id = asked.current;
    if (kind === "album" && s.coverId && suggest?.cover)
      suggest.cover(s.coverId).then(
        (found) => found && id === asked.current && setCover(found),
        (reason: unknown) => console.warn(`[parrot] edit dialog cover for ${s.coverId} failed: ${String(reason)}`),
      );
  };
  const undo = () => {
    if (!filled) return;
    stopAsking();
    setTexts(filled.before);
    typedFrom.current = {};
    setCover(filled.cover);
    setFilled(null);
  };

  const onFieldKey = (field: MusicSuggestField) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && list) {
      event.preventDefault();
      closeList();
    } else if (event.key === "ArrowDown" && !list) {
      event.preventDefault();
      ask(field, texts);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + options.length) % options.length);
    } else if (event.key === "Enter" && list && options[active]) {
      event.preventDefault();
      pick(options[active]);
    }
  };

  const field = (key: TextKey, label: string, extra: { inputMode?: "numeric"; className?: string; suggests?: MusicSuggestField } = {}) => {
    const value = texts[key];
    const set = (next: string) => {
      const all = { ...texts, [key]: next };
      if (extra.suggests && typedFrom.current[key] === undefined) typedFrom.current[key] = value;
      setTexts(all);
      if (extra.suggests) ask(extra.suggests, all);
    };
    const was = filled && filled.before[key].trim() !== value.trim() ? filled.before[key] : null;
    const listed = Boolean(extra.suggests && list?.field === extra.suggests && shown && suggestLabels);
    const restore = was !== null && suggestLabels ? suggestLabels.restore(was) : null;
    return (
      // content-end: in the four-column row a label that wraps keeps every box on one line.
      <div className={cn("grid content-end gap-1 text-sm", extra.className)}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
          <span className="shrink-0">{label}</span>
          {changed(key) ? (
            <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary" data-testid={`manage-changed-${key}`}>
              {labels.changed}
            </span>
          ) : null}
        </span>
        <div className="relative">
          {/* One box for every field, so the input keeps focus when the old value appears or goes. The B2 draft: what the
              field held before a pick sits struck through in the box, and ↺ puts it back. */}
          <div className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
            {was !== null && was.trim() && restore ? (
              <s className="max-w-[45%] shrink truncate text-muted-foreground" data-testid={`manage-was-${key}`}>
                {was}
              </s>
            ) : null}
            <Input
              value={value}
              onChange={(event) => set(event.target.value)}
              inputMode={extra.inputMode}
              aria-label={label}
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              data-testid={`manage-field-${key}`}
              {...(extra.suggests
                ? {
                    role: "combobox",
                    autoComplete: "off",
                    "aria-autocomplete": "list" as const,
                    "aria-expanded": listed,
                    "aria-controls": listed ? listId : undefined,
                    "aria-activedescendant": listed && options[active] ? `${listId}-${active}` : undefined,
                    onKeyDown: onFieldKey(extra.suggests),
                    onBlur: () => list?.field === extra.suggests && closeList(),
                  }
                : {})}
            />
            {was !== null && restore ? (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={restore}
                title={restore}
                onClick={() => setTexts((t) => ({ ...t, [key]: was }))}
                data-testid={`manage-restore-${key}`}
              >
                <RotateCcw className="size-3.5" />
              </button>
            ) : null}
          </div>
          {listed && list && shown && suggestLabels && (options.length > 0 || list.lookup.status !== "done") ? (
            <ParrotEditSuggestList
              id={listId}
              kind={kind}
              field={list.field}
              text={list.text}
              suggestions={shown}
              lookup={list.lookup}
              active={active}
              labels={suggestLabels}
              fieldLabels={labels.field}
              coverUrl={suggest?.coverUrl}
              onActive={setActive}
              onPick={pick}
            />
          ) : null}
        </div>
      </div>
    );
  };
  const suggests = (f: MusicSuggestField) => (suggest && suggestLabels ? f : undefined);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        closeLabel={labels.cancel}
        data-testid="manage-edit-dialog"
        onPaste={onPaste}
        onEscapeKeyDown={(event) => {
          // Esc closes an open list first, changing nothing; the dialog closes on the next one.
          if (!list) return;
          event.preventDefault();
          closeList();
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            {labels.body ? <DialogDescription>{labels.body}</DialogDescription> : null}
          </DialogHeader>
          {filled && suggestLabels ? (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-card/60 px-3 py-2 text-sm" role="status" data-testid="manage-suggest-filled">
              <span className="text-muted-foreground">{suggestLabels.filledFrom(filled.name)}</span>
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={undo} data-testid="manage-suggest-undo">
                {suggestLabels.undo}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3">
            {field("title", labels.field.title, { suggests: suggests("title") })}
            {field("artist", kind === "album" ? labels.field.albumArtist : labels.field.artist, { suggests: suggests("artist") })}
            {kind === "track" ? field("album", labels.field.album, { suggests: suggests("album") }) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {kind === "track" ? field("number", labels.field.number, { inputMode: "numeric" }) : null}
              {kind === "track" ? field("disc", labels.field.disc, { inputMode: "numeric" }) : null}
              {field("year", labels.field.year, { inputMode: "numeric" })}
              {field("genre", labels.field.genre, { className: kind === "album" ? "col-span-1 sm:col-span-3" : undefined })}
            </div>
            {kind === "album" ? (
              <div
                className="flex items-center gap-3 rounded-lg border border-dashed border-border p-3"
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDrop}
                data-testid="manage-cover-drop"
              >
                <div className="size-16 shrink-0 overflow-hidden rounded-md">
                  <ParrotCover seed={initial.title} label={initial.title} src={preview ?? coverUrl ?? null} />
                </div>
                <div className="grid gap-1 text-sm">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {labels.field.cover}
                    {cover ? (
                      <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary" data-testid="manage-changed-cover">
                        {labels.changed}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{labels.coverHint}</span>
                  <Button type="button" variant="ghost" size="sm" className="justify-start px-0" onClick={() => fileInput.current?.click()} data-testid="manage-cover-pick">
                    <ImagePlus className="size-4" /> {labels.coverPick}
                  </Button>
                  <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => void takeFile(event.target.files?.[0])} data-testid="manage-cover-file" />
                </div>
              </div>
            ) : null}
          </div>
          {lyrics && lyricsLabels ? <LyricsSection lyrics={lyrics} labels={lyricsLabels} /> : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="manage-edit-error">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={!fields.title || busy} data-testid="manage-edit-submit">
              {labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
