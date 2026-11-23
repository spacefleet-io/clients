/**
 * Managing the music library (PAR-LIB-03, PAR-LIB-04): the edit-details dialog every Parrot app opens for a song or
 * an album. Lookups run on their own; the dialog holds the manual ones, like Badger's: "Look it up again" for a wrong
 * match (PAR-META-18, it fills the fields with what was found, nothing saved until Save) and the Lyrics section
 * (PAR-LYR-05), which looks the lyrics up as it opens when the song never was. While something is being looked up it
 * shimmers; once the lookup came back empty it says so (PAR-META-20).
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { ImagePlus, RotateCw, Search } from "lucide-react";
import { Button } from "../button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { Input } from "../input";
import { cn } from "../utils";
import { ParrotCover } from "./components";
import {
  parrotEditFieldChanged,
  parrotEditNumber as numberOrNull,
  type ParrotEditAlbumLyricsState,
  type ParrotEditFields,
  type ParrotEditLyricsState,
} from "@space/parrot-core";

/** The dialog's "Look it up again" (PAR-META-18): `found` filled the fields, `none` found nothing better. */
export type ParrotEditLookUp = { state: "idle" | "busy" | "found" | "none" | "failed"; message?: string; onLookUp: () => void };

/** The dialog's Lyrics section (PAR-LYR-05): a song's words, or how many of an album's songs have some. */
export type ParrotEditLyrics =
  | { kind: "track"; state: ParrotEditLyricsState; onSearchAgain: () => void }
  | { kind: "album"; state: ParrotEditAlbumLyricsState; onSearchMissing: () => void };

export type ParrotEditLookUpLabels = {
  lookUp: string;
  lookUpHint: string;
  lookUpFound: string;
  searching: string;
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

function LookUpRow({ lookUp, labels }: { lookUp: ParrotEditLookUp; labels: ParrotEditLookUpLabels }) {
  const busy = lookUp.state === "busy";
  const note = lookUp.state === "found" ? labels.lookUpFound : lookUp.state === "none" || lookUp.state === "failed" ? lookUp.message : labels.lookUpHint;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-card/60 px-3 py-2 text-sm" data-testid="manage-look-up" data-state={lookUp.state}>
      <span className={cn("text-muted-foreground", lookUp.state === "failed" && "text-destructive")} role={lookUp.state === "failed" ? "alert" : undefined} data-testid="manage-look-up-note">
        {busy ? labels.searching : note}
      </span>
      <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={busy} aria-busy={busy || undefined} onClick={lookUp.onLookUp} data-testid="manage-look-up-button">
        <Search className="size-4" /> {labels.lookUp}
      </Button>
    </div>
  );
}

function LyricsSection({ lyrics, labels }: { lyrics: ParrotEditLyrics; labels: ParrotEditLookUpLabels }) {
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
  lookUp,
  lyrics,
  lookUpLabels,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "track" | "album";
  /** The values the form opens with (the found ones when reviewing a lookup). */
  initial: ParrotEditFields;
  /** The library's values: fields that differ from them are marked as changed. */
  current?: ParrotEditFields;
  coverUrl?: string | null;
  initialCover?: ParrotCoverInput | null;
  labels: ParrotEditLabels;
  error?: string | null;
  busy?: boolean;
  /** "Look it up again" (PAR-META-18); shown with `lookUpLabels`. */
  lookUp?: ParrotEditLookUp;
  /** The Lyrics section (PAR-LYR-05); shown with `lookUpLabels`. */
  lyrics?: ParrotEditLyrics;
  lookUpLabels?: ParrotEditLookUpLabels;
  onSubmit: (fields: ParrotEditFields, cover: ParrotCoverInput | null) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [artist, setArtist] = useState(initial.artist);
  const [album, setAlbum] = useState(initial.album ?? "");
  const [number, setNumber] = useState(initial.number ? String(initial.number) : "");
  const [disc, setDisc] = useState(String(initial.disc ?? 1));
  const [year, setYear] = useState(initial.year ? String(initial.year) : "");
  const [genre, setGenre] = useState(initial.genre ?? "");
  const [cover, setCover] = useState<ParrotCoverInput | null>(initialCover);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initial.title);
    setArtist(initial.artist);
    setAlbum(initial.album ?? "");
    setNumber(initial.number ? String(initial.number) : "");
    setDisc(String(initial.disc ?? 1));
    setYear(initial.year ? String(initial.year) : "");
    setGenre(initial.genre ?? "");
    setCover(initialCover);
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

  const fields = (): ParrotEditFields => ({
    title: title.trim(),
    artist: artist.trim(),
    ...(kind === "track" ? { album: album.trim(), number: numberOrNull(number), disc: numberOrNull(disc) ?? 1 } : {}),
    year: numberOrNull(year),
    genre: genre.trim() || null,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    onSubmit(fields(), cover);
  };
  const changed = (key: keyof ParrotEditFields) => parrotEditFieldChanged(fields(), current, key);

  const field = (key: keyof ParrotEditFields, label: string, value: string, set: (v: string) => void, extra: { inputMode?: "numeric"; className?: string } = {}) => (
    <label className={cn("grid gap-1 text-sm", extra.className)}>
      <span className="flex items-center gap-2 text-muted-foreground">
        {label}
        {changed(key) ? (
          <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary" data-testid={`manage-changed-${key}`}>
            {labels.changed}
          </span>
        ) : null}
      </span>
      <Input value={value} onChange={(event) => set(event.target.value)} inputMode={extra.inputMode} aria-label={label} data-testid={`manage-field-${key}`} />
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" closeLabel={labels.cancel} data-testid="manage-edit-dialog" onPaste={onPaste}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            {labels.body ? <DialogDescription>{labels.body}</DialogDescription> : null}
          </DialogHeader>
          {lookUp && lookUpLabels ? <LookUpRow lookUp={lookUp} labels={lookUpLabels} /> : null}
          <div className="grid gap-3">
            {field("title", labels.field.title, title, setTitle)}
            {field("artist", kind === "album" ? labels.field.albumArtist : labels.field.artist, artist, setArtist)}
            {kind === "track" ? field("album", labels.field.album, album, setAlbum) : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {kind === "track" ? field("number", labels.field.number, number, setNumber, { inputMode: "numeric" }) : null}
              {kind === "track" ? field("disc", labels.field.disc, disc, setDisc, { inputMode: "numeric" }) : null}
              {field("year", labels.field.year, year, setYear, { inputMode: "numeric" })}
              {field("genre", labels.field.genre, genre, setGenre, { className: kind === "album" ? "col-span-1 sm:col-span-3" : undefined })}
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
                    {cover ? <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary">{labels.changed}</span> : null}
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
          {lyrics && lookUpLabels ? <LyricsSection lyrics={lyrics} labels={lookUpLabels} /> : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="manage-edit-error">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={!title.trim() || busy} data-testid="manage-edit-submit">
              {labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
