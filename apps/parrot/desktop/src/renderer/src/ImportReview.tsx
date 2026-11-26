import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, BookCheck, Crop as CropIcon, Disc3, Eraser, FileAudio, GripVertical, ImageUp, Pencil, SearchX, WifiOff } from "lucide-react";
import {
  Button,
  Checkbox,
  ImportReviewActions,
  ImportReviewBadge,
  ImportReviewBody,
  ImportReviewDetail,
  ImportReviewDialog,
  ImportReviewFooter,
  ImportReviewList,
  ImportReviewMatchResult,
  ImportReviewMatchSearch,
  ImportReviewNoMatch,
  ImportReviewRow,
  ImportReviewSearching,
  ImportReviewSection,
  ImportReviewSummary,
  Input,
  Spinner,
} from "@space/ui";
import { ParrotCover } from "@space/ui/parrot";
import { ParrotCoverFrameDialog, ParrotFramedCover as FramedCover, type ParrotCoverFrameLabels } from "@space/ui/parrot/cover-frame";
import { ParrotPhotoCreditLine } from "@space/ui/parrot/library";
import { ParrotEditSuggestList, suggestionName, type ParrotEditSuggest } from "@space/ui/parrot/manage";
import { formatLocalizedStorage } from "@space/shared/format";
import {
  cleanParrotTitles,
  matchParrotImportTracks,
  mergeParrotEditSuggestions,
  parrotAlbumArtists,
  parrotAlbumKey,
  parrotImportFromMatch,
  type ParrotCoverCrop,
  type ParrotEditSuggestion,
  type ParrotTitleCleanupApplied,
  type ParrotTitleCleanupRule,
} from "@space/parrot-core";
import type {
  ParrotImportAlbumMatch,
  ParrotImportAlbumSearch,
  ParrotImportArtistPhoto,
  ParrotImportEdit,
  ParrotImportFoundAlbum,
  ParrotImportPicture,
  ParrotImportScan,
  ParrotLanguage,
  ParrotScanEntry,
} from "../../shared/ipc";
import { editSuggestLabels } from "./editSuggest";
import { countText, type Translate } from "./i18n";

/** "Frame the cover" (PAR-META-22) in the window's language, for the import dialog and Edit details. */
export const coverFrameLabels = (t: Translate): ParrotCoverFrameLabels => ({
  title: t("import.frame.title"),
  hint: t("import.frame.hint"),
  preview: t("import.frame.preview"),
  size: (picture) => t("import.frame.size", picture),
  centre: t("import.frame.centre"),
  cancel: t("import.frame.cancel"),
  use: t("import.frame.use"),
});

type Props = { t: Translate; language: ParrotLanguage; scan: ParrotImportScan; onDone: () => void; suggest?: ParrotEditSuggest };

/** An album of our music library songs are placed on, with whether its tracklist is whole (false: the album lookup failed). */
type FoundAlbum = ParrotImportFoundAlbum & { tracklistKnown: boolean };
/** Where a matched song goes: a track of an album (`number` null: added by the user, not on the tracklist). */
type Place = { albumKey: string; disc: number; number: number | null; sure: boolean };
/** An album as the files' tags name it: the review shows it at once and looks it up on its own (PAR-UP-08). */
type FileAlbum = { key: string; title: string; artist: string; year: number | null; files: string[] };
/** Where a file album's lookup is: stopped by its "Import as is", answered, or unable to ask. */
type Lookup = "searching" | "stopped" | "done" | "failed";
/** The album names the user typed for a card (a typed name, even emptied, wins). */
type AlbumTyped = { album?: string; artist?: string; year?: string };
/** The cover the user chose for a card (null: the card's own) and the square they framed on it (null: the centre). */
type CoverChoice = { picture: ParrotImportPicture | null; crop: ParrotCoverCrop | null };
/**
 * One album card of the review: a file album named by its tags (looking up, imported as is, or not found), or an
 * album of our music library the lookup placed songs on. `rank` keeps a card where its file album was in the list.
 */
type Card =
  | { kind: "file"; key: string; rank: number; source: FileAlbum; files: ParrotScanEntry[]; state: "searching" | "asis" | "notfound" | "failed" }
  | { kind: "library"; key: string; rank: number; found: FoundAlbum; files: ParrotScanEntry[]; state: "matched" };

/** The metadata's id of "Various Artists", the album artist of a compilation whose songs each keep their own artist. */
const VARIOUS_ARTISTS_ID = "89ad4ac3-39f7-470e-963a-56509c546377";
/** How many albums are looked up at once (the service spaces its own calls; each album asks a few). */
const IMPORT_LOOKUP_LANES = 3;
/** How many covers the dialog asks at once: the service spaces its own calls to each cover source (META-PUB-02). */
const IMPORT_COVER_LANES = 3;
/** The pause after a keystroke before the artist field asks our music library (as the edit dialog does). */
const LOOKUP_PAUSE_MS = 250;

/** The v3 drafts' field looks (Chris 2026-11-21): at rest a quiet box, on hover the input's border, while typing the ring. */
const FIELD_LOOK =
  "border-border/50 bg-muted/20 hover:border-input hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const PILL = "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4";

const trackKey = (track: { disc: number; number: number }) => `${track.disc}:${track.number}`;
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const duration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return "";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
/** A typed year: four digits, else none. */
const yearOf = (text: string): number | null => (/^\d{4}$/.test(text.trim()) ? Number(text.trim()) : null);
/** The album's artists' names, as its row and header say them ("Linnet Park & Jun-O"). */
const artistNames = (found: ParrotImportFoundAlbum) => parrotAlbumArtists(found.album).map((artist) => artist.name).join(" & ");
const isVariousArtists = (found: ParrotImportFoundAlbum) =>
  found.album.artist.id === VARIOUS_ARTISTS_ID || found.album.artist.name.trim().toLowerCase() === "various artists";

/** The tags' album a song is on: its album artist (else its artist) and album, as the scan read them. */
const fileAlbumKey = (entry: ParrotScanEntry) => `${(entry.albumArtist || entry.artist).trim().toLocaleLowerCase()}\u0000${entry.album.trim().toLocaleLowerCase()}`;
const tagOrder = (a: ParrotScanEntry, b: ParrotScanEntry) => a.disc - b.disc || a.number - b.number || a.title.localeCompare(b.title);

/** The spelling most of `names` use; the first in order breaks a tie. */
const commonest = (names: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return names.reduce((best, name) => ((counts.get(name) ?? 0) > (counts.get(best) ?? 0) ? name : best), names[0] ?? "");
};

/** The scan's songs grouped as their tags name their albums (each name spelled as most of its songs do), by artist, then year, then title. */
export const parrotFileAlbums = (entries: readonly ParrotScanEntry[]): FileAlbum[] => {
  const byKey = new Map<string, ParrotScanEntry[]>();
  for (const entry of entries) byKey.set(fileAlbumKey(entry), [...(byKey.get(fileAlbumKey(entry)) ?? []), entry]);
  return [...byKey.entries()]
    .map(([key, files]) => {
      const sorted = [...files].sort(tagOrder);
      return {
        key,
        title: commonest(sorted.map((entry) => entry.album)),
        artist: commonest(sorted.map((entry) => entry.albumArtist || entry.artist)),
        year: sorted.find((entry) => entry.year)?.year ?? null,
        files: sorted.map((entry) => entry.file),
      };
    })
    .sort((a, b) => a.artist.localeCompare(b.artist) || (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title));
};

/**
 * PAR-UP-08: the numbers a file album's songs take in the order the review shows them. They keep the slots their tags
 * hold, ascending, so dragging a song swaps which song sits on which number; tags with a missing number or the same
 * one twice are numbered 1..n instead.
 */
export const parrotImportSlots = (entries: readonly Pick<ParrotScanEntry, "disc" | "number">[]): Array<{ disc: number; number: number }> => {
  const slots = entries.map((entry) => ({ disc: entry.disc > 0 ? entry.disc : 1, number: entry.number })).sort((a, b) => a.disc - b.disc || a.number - b.number);
  const distinct = new Set(slots.map(trackKey)).size === slots.length;
  return distinct && slots.every((slot) => slot.number > 0) ? slots : entries.map((_, index) => ({ disc: 1, number: index + 1 }));
};

/**
 * Asks the covers of `ids` in their order, `IMPORT_COVER_LANES` at a time, and hands each to `onCover` as it comes;
 * stops asking once `live()` turns false. A failed cover answers null (the disc stays).
 */
const askCovers = async (ids: readonly string[], live: () => boolean, onCover: (id: string, cover: string | null) => void) => {
  let next = 0;
  const lane = async () => {
    while (next < ids.length && live()) {
      const id = ids[next++];
      const cover = await window.parrot.importCover(id).catch((error: unknown) => {
        console.warn(`[import-review] cover ${id} failed`, error);
        return null;
      });
      console.info(`[import-review] cover ${id}: ${cover ? "found" : "none"}`);
      if (live()) onCover(id, cover);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_COVER_LANES, ids.length) }, lane));
};

/**
 * The covers of a search's albums (PAR-UP-05): the search answers without them, then the albums' covers are asked a
 * few at a time (`askCovers`) and each is drawn as it comes; the disc shows meanwhile. Answers `found` with its cover
 * filled.
 */
function useSearchCovers(answer: ParrotImportAlbumSearch | null) {
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  const ids = answer?.kind === "found" ? [...new Set(answer.results.flatMap((found) => found.album.id ?? []))].join(",") : "";
  useEffect(() => {
    if (!ids) return;
    let stale = false;
    void askCovers(ids.split(","), () => !stale, (id, cover) => setCovers((previous) => ({ ...previous, [id]: cover })));
    return () => {
      stale = true;
    };
  }, [ids]);
  return <Found extends ParrotImportFoundAlbum>(found: Found): Found => {
    const id = found.album.id;
    return found.cover || !id || !covers[id] ? found : { ...found, cover: covers[id] };
  };
}

/** Where a card's names come from (PAR-UP-08): one badge per album card. */
function SourcePill({ t, library }: { t: Translate; library: boolean }) {
  return library ? (
    <span className={`${PILL} border-primary/40 bg-primary/10 text-primary`} data-testid="import-source" data-source="library">
      <BookCheck className="h-3 w-3" aria-hidden />
      {t("import.source.library")}
    </span>
  ) : (
    <span className={`${PILL} border-amber-400/40 bg-amber-400/10 text-amber-200`} data-testid="import-source" data-source="file">
      <FileAudio className="h-3 w-3" aria-hidden />
      {t("import.source.file")}
    </span>
  );
}

/** A name the user can change in place: a quiet box with a pencil at rest, the input's border on hover, the ring while typing. */
function PencilField({
  label,
  value,
  onChange,
  testId,
  big,
  className,
  numeric,
  onKeyDown,
  onBlur,
  combobox,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  big?: boolean;
  className?: string;
  numeric?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  combobox?: { listId: string; open: boolean; active?: string };
  children?: ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground">{label}</span>
      <div className="group relative">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          inputMode={numeric ? "numeric" : undefined}
          className={`${big ? "h-11 text-lg font-semibold" : "h-9"} pr-9 ${FIELD_LOOK}`}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          data-testid={testId}
          {...(combobox
            ? {
                role: "combobox",
                autoComplete: "off",
                "aria-autocomplete": "list" as const,
                "aria-expanded": combobox.open,
                "aria-controls": combobox.open ? combobox.listId : undefined,
                "aria-activedescendant": combobox.active,
              }
            : {})}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted-foreground">
          <Pencil className="h-3.5 w-3.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" aria-hidden />
        </span>
        {children}
      </div>
    </div>
  );
}

type SuggestState = { text: string; library: ParrotEditSuggestion[]; lookup: { status: "asking" } | { status: "done" } | { status: "failed"; reason: string }; found: ParrotEditSuggestion[] };

/**
 * The album's artist with the edit dialog's autocomplete (PAR-META-18): our library's artists at once, the music
 * library's after a pause. A pick fills the artist, and the album too when the pick is an album.
 */
function ArtistField({
  t,
  id,
  value,
  album,
  suggest,
  onChange,
  onPick,
}: {
  t: Translate;
  id: string;
  value: string;
  album: string;
  suggest?: ParrotEditSuggest;
  onChange: (value: string) => void;
  onPick: (artist: string, album: string | null) => void;
}) {
  const [list, setList] = useState<SuggestState | null>(null);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(0);
  const stop = () => {
    asked.current++;
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const ask = (text: string) => {
    stop();
    setActive(0);
    if (!suggest || text.trim() === "") return setList(null);
    const query = { kind: "album" as const, field: "artist" as const, text, fields: { title: album, artist: text } };
    const at = asked.current;
    setList({ text, library: suggest.library(query), lookup: { status: "asking" }, found: [] });
    timer.current = setTimeout(() => {
      timer.current = null;
      suggest.lookup(query).then(
        (found) => at === asked.current && setList((open) => open && { ...open, lookup: { status: "done" }, found }),
        (reason: unknown) => at === asked.current && setList((open) => open && { ...open, lookup: { status: "failed", reason: reason instanceof Error ? reason.message : String(reason) } }),
      );
    }, LOOKUP_PAUSE_MS);
  };
  const close = () => {
    stop();
    setList(null);
  };
  const shown = list ? mergeParrotEditSuggestions(list.library, list.found) : null;
  const options = shown ? [...shown.all, ...shown.field] : [];
  const pick = (s: ParrotEditSuggestion) => {
    close();
    onPick(suggestionName(s, "artist"), s.kind === "artist" ? null : (s.album?.title ?? null));
  };
  const listId = `import-artist-${id}`;
  const open = Boolean(list && shown && (options.length > 0 || list.lookup.status !== "done"));
  return (
    <PencilField
      label={t("import.review.artist")}
      value={value}
      onChange={(next) => {
        onChange(next);
        ask(next);
      }}
      testId="import-field-artist"
      className="min-w-0 flex-1"
      onBlur={close}
      combobox={suggest ? { listId, open, active: open && options[active] ? `${listId}-${active}` : undefined } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && list) {
          event.preventDefault();
          close();
        } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((at) => (at + step + options.length) % options.length);
        } else if (event.key === "Enter" && list && options[active]) {
          event.preventDefault();
          pick(options[active]);
        }
      }}
    >
      {open && list && shown ? (
        <ParrotEditSuggestList
          id={listId}
          kind="album"
          field="artist"
          text={list.text}
          suggestions={shown}
          lookup={list.lookup}
          active={active}
          labels={editSuggestLabels(t)}
          fieldLabels={{ title: t("import.review.album"), artist: t("import.review.artist"), album: t("import.review.album"), albumArtist: t("import.review.artist") }}
          coverUrl={suggest?.coverUrl}
          onActive={setActive}
          onPick={pick}
        />
      ) : null}
    </PencilField>
  );
}

/**
 * "Here's what I found in your music folder" (PAR-UP-08, Chris's v3 approval 2026-11-21): the albums show at once as
 * the files' tags name them, and each looks itself up in our music library on its own, a few at a time. An album
 * still looking up has its own "Import as is", which stops only its lookup; one the lookup finds nothing for goes in as
 * is by itself, so a lookup never blocks the import. A found album becomes the library's album card ("Check" when some
 * songs differ a little, its missing tracks greyed); songs it placed nowhere stay in their file album. Every card says
 * where its names come from and lets the user change the album, its artist (with the edit dialog's autocomplete), its
 * year and each song's name; the cover is its own picker (pictures in the files, an image file, and "Frame the cover",
 * PAR-META-22); a file album's songs reorder by dragging and their numbers follow. Import turns on once no album is
 * looking up; it uploads only the ticked songs, Cancel nothing. Built on the family's import review (REL-FAM-02).
 */
export default function ImportReview({ t, language, scan, onDone, suggest }: Props) {
  const fileAlbums = useMemo(() => parrotFileAlbums(scan.entries), [scan]);
  /** PAR-META-23: the clean-ups each file album proposes for its names, by its key, and the ones the user undid. */
  const [undone, setUndone] = useState<Record<string, ReadonlySet<ParrotTitleCleanupRule>>>({});
  const cleanups = useMemo(() => {
    const tagged = new Map(scan.entries.map((entry) => [entry.file, entry]));
    return new Map(
      fileAlbums.map((album) => {
        const input = { artist: album.artist, album: album.title, titles: album.files.map((file) => tagged.get(file)?.title ?? "") };
        return [album.key, { proposed: cleanParrotTitles(input).applied, now: cleanParrotTitles(input, undone[album.key]) }] as const;
      }),
    );
  }, [scan, fileAlbums, undone]);
  /** The scan's songs as the review shows them: their tags, with their album's clean-ups applied. */
  const entries = useMemo(() => {
    const shown = new Map(scan.entries.map((entry) => [entry.file, entry]));
    for (const album of fileAlbums) {
      const now = cleanups.get(album.key)?.now;
      if (!now) continue;
      album.files.forEach((file, index) => {
        const entry = shown.get(file);
        if (entry) shown.set(file, { ...entry, title: now.titles[index] ?? entry.title, album: now.album === album.title ? entry.album : now.album });
      });
    }
    return shown;
  }, [scan, fileAlbums, cleanups]);
  const rankOf = useMemo(() => new Map(fileAlbums.flatMap((album, rank) => album.files.map((file) => [file, rank] as const))), [fileAlbums]);

  const [lookups, setLookups] = useState<Record<string, Lookup>>(() => Object.fromEntries(fileAlbums.map((album) => [album.key, "searching" as const])));
  const stopped = useRef(new Set<string>());
  const [albums, setAlbums] = useState<Record<string, FoundAlbum>>({});
  const [places, setPlaces] = useState<Record<string, Place>>({});
  /** Songs the lookup could place nowhere: imported as is, marked to be identified later. */
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  /** Albums whose "Check" the user answered with "Looks right". */
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  /** Only the song names the user typed: a typed name (even emptied) wins over the match and the tags. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [albumTyped, setAlbumTyped] = useState<Record<string, AlbumTyped>>({});
  /** A file album's songs in the order the user dragged them to. */
  const [order, setOrder] = useState<Record<string, string[]>>({});
  const [covers, setCovers] = useState<Record<string, CoverChoice>>({});
  const [picturesOf, setPicturesOf] = useState<Record<string, ParrotImportPicture[]>>({});
  const askedPictures = useRef(new Set<string>());
  /** The card whose details show, named by one of its songs (a card follows its songs when it turns into another). */
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [coverMenu, setCoverMenu] = useState(false);
  const [framing, setFraming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** The matched artists' photos (PAR-UP-06), by their id in the metadata; an artist not in it yet is still being asked. */
  const [photos, setPhotos] = useState<Record<string, ParrotImportArtistPhoto>>({});
  const askedPhotos = useRef(new Set<string>());

  // Each album looks itself up on its own, IMPORT_LOOKUP_LANES at a time, in the list's order.
  useEffect(() => {
    console.info(`[import-review] showing ${scan.entries.length} song(s) on ${fileAlbums.length} album(s), ${scan.unreadable.length} unreadable; looking each album up`);
    let live = true;
    const show = (album: FileAlbum, answer: ParrotImportAlbumMatch) => {
      if (answer.kind === "stopped") {
        setLookups((previous) => ({ ...previous, [album.key]: "stopped" }));
        return;
      }
      const failed = answer.albums.length === 0 && answer.unidentified.length > 0 && answer.unidentified.every((file) => file.reason === "lookup-failed");
      console.info(`[import-review] album ${JSON.stringify(album.title)}: ${answer.albums.length} album(s) found, ${answer.unidentified.length} song(s) as is${failed ? " (lookup failed)" : ""}`);
      setAlbums((previous) => {
        const next = { ...previous };
        for (const { files: _files, ...found } of answer.albums) next[parrotAlbumKey(found.album)] ??= found;
        return next;
      });
      setPlaces((previous) => ({
        ...previous,
        ...Object.fromEntries(answer.albums.flatMap((found) => found.files.map((file) => [file.file, { albumKey: parrotAlbumKey(found.album), disc: file.disc, number: file.number, sure: file.sure }]))),
      }));
      if (answer.unidentified.length > 0) setLost((previous) => new Set([...previous, ...answer.unidentified.map((file) => file.file)]));
      setLookups((previous) => ({ ...previous, [album.key]: failed ? "failed" : "done" }));
      // The covers come after the albums (#2509): a few at a time, each drawn as it comes; the disc shows meanwhile.
      const ids = [...new Set(answer.albums.flatMap((found) => (!found.cover && found.album.id ? [found.album.id] : [])))];
      void askCovers(ids, () => live, (id, cover) => {
        if (!cover) return;
        setAlbums((previous) => Object.fromEntries(Object.entries(previous).map(([key, found]) => [key, found.album.id === id && !found.cover ? { ...found, cover } : found])));
      });
    };
    let next = 0;
    const lane = async () => {
      while (live && next < fileAlbums.length) {
        const album = fileAlbums[next++];
        if (stopped.current.has(album.key)) continue;
        const answer = await window.parrot.matchImportAlbum({ id: album.key, files: album.files }).catch((error: unknown): ParrotImportAlbumMatch => {
          console.warn(`[import-review] album ${JSON.stringify(album.title)} lookup failed`, error);
          return { kind: "found", albums: [], unidentified: album.files.map((file) => ({ file, reason: "lookup-failed" as const })) };
        });
        if (live && !stopped.current.has(album.key)) show(album, answer);
      }
    };
    void Promise.all(Array.from({ length: Math.min(IMPORT_LOOKUP_LANES, fileAlbums.length) }, lane));
    return () => {
      live = false;
    };
  }, [scan, fileAlbums]);

  /** The album cards: file albums keep their place in the list, a found album takes its songs' place. */
  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    fileAlbums.forEach((source, rank) => {
      const key = `file:${source.key}`;
      const dragged = (order[key] ?? []).filter((file) => source.files.includes(file));
      const files = [...dragged, ...source.files.filter((file) => !dragged.includes(file))]
        .filter((file) => !places[file])
        .flatMap((file) => entries.get(file) ?? []);
      if (files.length === 0) return;
      const lookup = lookups[source.key] ?? "searching";
      const state = lookup === "searching" ? "searching" : lookup === "stopped" ? "asis" : lookup === "failed" ? "failed" : "notfound";
      out.push({ kind: "file", key, rank, source: { ...source, title: cleanups.get(source.key)?.now.album ?? source.title }, files, state });
    });
    const byAlbum = new Map<string, ParrotScanEntry[]>();
    for (const [file, place] of Object.entries(places)) {
      const entry = entries.get(file);
      if (entry && albums[place.albumKey]) byAlbum.set(place.albumKey, [...(byAlbum.get(place.albumKey) ?? []), entry]);
    }
    const onAlbum = (entry: ParrotScanEntry) => {
      const place = places[entry.file];
      return place.number === null ? Number.MAX_SAFE_INTEGER : place.disc * 10_000 + place.number;
    };
    for (const [albumKey, files] of byAlbum) {
      files.sort((a, b) => onAlbum(a) - onAlbum(b) || a.title.localeCompare(b.title));
      out.push({ kind: "library", key: `lib:${albumKey}`, rank: Math.min(...files.map((entry) => rankOf.get(entry.file) ?? 0)), found: albums[albumKey], files, state: "matched" });
    }
    return out.sort((a, b) => a.rank - b.rank || (a.kind === b.kind ? 0 : a.kind === "library" ? -1 : 1));
  }, [fileAlbums, cleanups, order, places, entries, lookups, albums, rankOf]);

  const cardOf = useMemo(() => new Map(cards.flatMap((card) => card.files.map((entry) => [entry.file, card] as const))), [cards]);
  /**
   * Each file album song's number. Numbers made up for songs whose tags have none (1..n, `parrotImportSlots`) count
   * only once the user has ordered that album; until then a song keeps its tags' number, or none, so an untouched
   * song takes no slot of an album the library already has (PAR-LIB-05).
   */
  const slotOf = useMemo(
    () =>
      new Map(
        cards.flatMap((card) => {
          if (card.kind !== "file") return [];
          const slots = parrotImportSlots(card.files);
          const ordered = order[card.key] !== undefined;
          return card.files.map((entry, index) => [entry.file, ordered ? slots[index] : { disc: entry.disc > 0 ? entry.disc : 1, number: entry.number }] as const);
        }),
      ),
    [cards, order],
  );
  const current = (selectedFile ? cardOf.get(selectedFile) : undefined) ?? cards[0] ?? null;
  const looking = cards.filter((card) => card.state === "searching").length;

  // Each card's pictures (the covers built into its files) are asked once, one card at a time.
  const cardKeys = cards.map((card) => card.key).join("|");
  const cardsNow = useRef(cards);
  cardsNow.current = cards;
  useEffect(() => {
    const missing = cardsNow.current.filter((card) => !askedPictures.current.has(card.key));
    if (missing.length === 0) return;
    for (const card of missing) askedPictures.current.add(card.key);
    void (async () => {
      for (const card of missing) {
        const pictures = await window.parrot.importAlbumPictures(card.files.map((entry) => entry.file)).catch((error: unknown) => {
          console.warn(`[import-review] pictures of ${card.key} failed`, error);
          return [] as ParrotImportPicture[];
        });
        setPicturesOf((previous) => ({ ...previous, [card.key]: [...pictures].sort((a, b) => b.files - a.files) }));
      }
    })();
  }, [cardKeys]);

  /** Every matched album's artists (PAR-UP-06), each once: their photos are asked for the album headers. */
  const artistIds = [
    ...new Set(cards.flatMap((card) => (card.kind === "library" ? parrotAlbumArtists(card.found.album).flatMap((artist) => (artist.id ? [artist.id] : [])) : []))),
  ].join(",");
  // Each artist's photo is asked once, one at a time (polite to the lookup); the drawn picture shows meanwhile.
  useEffect(() => {
    const missing = artistIds ? artistIds.split(",").filter((artistId) => !askedPhotos.current.has(artistId)) : [];
    if (missing.length === 0) return;
    for (const artistId of missing) askedPhotos.current.add(artistId);
    void (async () => {
      for (const artistId of missing) {
        const answer = await window.parrot.importArtistPhoto(artistId).catch((error: unknown) => {
          console.warn(`[import-review] artist photo ${artistId} failed`, error);
          return { photo: null, credit: null };
        });
        console.info(`[import-review] artist photo ${artistId}: ${answer.photo ? "found" : "none"}`);
        setPhotos((previous) => ({ ...previous, [artistId]: answer }));
      }
    })();
  }, [artistIds]);

  /** The cover a card shows and imports: the user's choice, else the library's cover, else its files' commonest picture. */
  const coverOf = (card: Card): { src: string | null; picture: ParrotImportPicture | null; crop: ParrotCoverCrop | null } => {
    const choice = covers[card.key];
    const crop = choice?.crop ?? null;
    if (choice?.picture) return { src: choice.picture.data, picture: choice.picture, crop };
    if (card.kind === "library" && card.found.cover) return { src: card.found.cover, picture: null, crop };
    const picture = picturesOf[card.key]?.[0] ?? null;
    return { src: picture?.data ?? null, picture, crop };
  };
  /** The confirm's cover fields: a chosen or framed file picture by its id, a framed library cover by its crop. */
  const coverEdit = (card: Card): Pick<ParrotImportEdit, "coverPicture" | "coverCrop"> => {
    const { picture, crop } = coverOf(card);
    if (covers[card.key]?.picture && picture) return { coverPicture: picture.id, ...(crop ? { coverCrop: crop } : {}) };
    if (!crop) return {};
    return picture ? { coverPicture: picture.id, coverCrop: crop } : { coverCrop: crop };
  };

  /**
   * What the import stores for a song. A file album's song: its tags, the names typed on its card, the number its
   * place in the card gives it (PAR-UP-08). A matched song: the typed names, else the matched track's, else the tags;
   * it takes the release's album artist (a "Various Artists" tag stands only when the match is itself a various-artists
   * compilation, whose songs keep their own artist) and the cover the review shows (PAR-META-04).
   */
  const named = (entry: ParrotScanEntry, card: Card): ParrotImportEdit => {
    const own = typed[entry.file];
    const at = albumTyped[card.key] ?? {};
    const year = at.year === undefined ? undefined : yearOf(at.year);
    if (card.kind === "file") {
      const slot = slotOf.get(entry.file) ?? { disc: entry.disc, number: entry.number };
      const byCardArtist = !entry.artist || entry.artist === card.source.artist;
      return {
        title: own ?? entry.title,
        artist: at.artist !== undefined && byCardArtist ? at.artist : entry.artist,
        album: at.album ?? entry.album,
        ...(at.artist !== undefined ? { albumArtist: at.artist } : {}),
        ...(year !== undefined ? { year } : {}),
        ...(slot.number > 0 ? { number: slot.number, disc: slot.disc } : {}),
        ...coverEdit(card),
        // Only a song the lookup could not place is marked to be identified later; "Import as is" is the user's choice.
        ...(lost.has(entry.file) ? { unidentified: true } : {}),
      };
    }
    const { album, tracklistKnown, cover } = card.found;
    const place = places[entry.file];
    const track = place?.number == null ? null : (album.tracks.find((candidate) => candidate.disc === place.disc && candidate.number === place.number) ?? null);
    const fill = track ? parrotImportFromMatch(album, track) : null;
    const variousArtists = isVariousArtists(card.found);
    return {
      title: own ?? fill?.title ?? entry.title,
      artist: variousArtists ? entry.artist : (at.artist ?? album.artist.name),
      album: at.album ?? album.title,
      albumArtist: at.artist ?? album.artist.name,
      albumArtistMusicId: at.artist === undefined ? album.artist.id : null,
      year: year !== undefined ? year : album.year,
      ...(fill ? { number: fill.number, disc: fill.disc } : {}),
      // The album's full tracklist (PAR-LIB-05), only when the album lookup gave it whole.
      ...(tracklistKnown ? { tracklist: album.tracks.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs })) } : {}),
      // The album's id in the metadata (PAR-COPY-01), so later refreshes and the cover pass find it.
      ...(album.id ? { albumMusicId: album.id } : {}),
      ...(cover && album.id ? { coverId: album.id } : {}),
      ...coverEdit(card),
    };
  };

  /** The ticked songs as the review shows them (PAR-META-23: their album's clean-ups applied). */
  const importing = scan.entries.flatMap((entry) => (unticked.has(entry.file) ? [] : [entries.get(entry.file) ?? entry]));
  const importingBytes = importing.reduce((sum, entry) => sum + entry.size, 0);

  const setTicked = (files: string[], on: boolean) =>
    setUnticked((previous) => {
      const next = new Set(previous);
      for (const file of files) {
        if (on) next.delete(file);
        else next.add(file);
      }
      return next;
    });
  const select = (card: Card) => {
    setSelectedFile(card.files[0]?.file ?? null);
    setCoverMenu(false);
  };
  const stopLookup = (card: Card) => {
    if (card.kind !== "file") return;
    console.info(`[import-review] album ${JSON.stringify(card.source.title)}: import as is, lookup stopped by the user`);
    stopped.current.add(card.source.key);
    setLookups((previous) => ({ ...previous, [card.source.key]: "stopped" }));
    void window.parrot.stopImportAlbumMatch(card.source.key).catch((error: unknown) => console.warn("[import-review] stop failed", error));
  };
  const typeAlbum = (card: Card, field: keyof AlbumTyped, value: string) => setAlbumTyped((previous) => ({ ...previous, [card.key]: { ...previous[card.key], [field]: value } }));
  const takenOn = (albumKey: string, except: string[] = []) =>
    Object.entries(places)
      .filter(([file, placed]) => placed.albumKey === albumKey && placed.number !== null && !except.includes(file))
      .map(([, placed]) => ({ disc: placed.disc, number: placed.number as number }));

  /** "Wrong album? Search": the card's songs move onto the picked album's tracks; one with no track stays as is. */
  const chooseAlbum = (card: Card, found: ParrotImportFoundAlbum) => {
    const target: FoundAlbum = { ...found, tracklistKnown: true };
    const albumKey = parrotAlbumKey(target.album);
    const songs = card.files.map((entry) => ({ file: entry.file, title: named(entry, card).title, disc: entry.disc, number: entry.number }));
    const paired = matchParrotImportTracks(songs, target.album, takenOn(albumKey, card.files.map((entry) => entry.file)));
    const onTracks = [...paired].flatMap(([file, track]) => (track ? [{ file, disc: track.disc, number: track.number }] : []));
    const off = [...paired].flatMap(([file, track]) => (track ? [] : [file]));
    console.info(`[import-review] ${card.key} replaced by search: ${albumKey}, ${onTracks.length} song(s) on its tracks, ${off.length} as is`);
    setTyped((previous) => Object.fromEntries(Object.entries(previous).filter(([file]) => !onTracks.some((placed) => placed.file === file))));
    setAlbums((previous) => ({ ...previous, [albumKey]: previous[albumKey] ?? target }));
    setPlaces((previous) => {
      const next = Object.fromEntries(Object.entries(previous).filter(([file]) => !off.includes(file)));
      for (const { file, disc, number } of onTracks) next[file] = { albumKey, disc, number, sure: true };
      return next;
    });
    setLost((previous) => new Set([...previous].filter((file) => !onTracks.some((placed) => placed.file === file))));
    setConfirmed((previous) => new Set(previous).add(albumKey));
    if (onTracks[0]) setSelectedFile(onTracks[0].file);
  };
  /** "Not this album": the songs go back to their file albums, as is, to be identified later. */
  const clearMatch = (card: Card) => {
    const files = card.files.map((entry) => entry.file);
    console.info(`[import-review] match ${card.key} cleared: ${files.length} song(s) back as is`);
    setPlaces((previous) => Object.fromEntries(Object.entries(previous).filter(([file]) => !files.includes(file))));
    setLost((previous) => new Set([...previous, ...files]));
  };
  /** Moves a file album's song to `to` (an index between its songs); the numbers follow the order. */
  const moveSong = (card: Card, file: string, to: number) => {
    const list = card.files.map((entry) => entry.file);
    const from = list.indexOf(file);
    if (from < 0) return;
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to > from ? to - 1 : to)), 0, file);
    setOrder((previous) => ({ ...previous, [card.key]: list }));
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    console.info("[import-review] cancel: nothing is uploaded");
    await window.parrot.cancelImport();
    onDone();
  };
  const confirm = async () => {
    if (busy || looking > 0) return;
    setBusy(true);
    const selection = importing.flatMap((entry) => {
      const card = cardOf.get(entry.file);
      return card ? [{ file: entry.file, ...named(entry, card) }] : [];
    });
    const asIs = selection.filter((item) => item.unidentified).length;
    const framed = Object.values(covers).filter((choice) => choice.crop).length;
    console.info(
      `[import-review] confirm: ${selection.length} of ${scan.entries.length} song(s) on ${cards.length} album(s), ${asIs} to identify later, ${Object.keys(typed).length + Object.keys(albumTyped).length} edited, ${framed} cover(s) framed`,
    );
    await window.parrot.confirmImport(selection);
    onDone();
  };

  const cardTitle = (card: Card) => albumTyped[card.key]?.album ?? (card.kind === "file" ? card.source.title : card.found.album.title);
  const cardArtist = (card: Card) => albumTyped[card.key]?.artist ?? (card.kind === "file" ? card.source.artist : artistNames(card.found));
  const cardYear = (card: Card) => albumTyped[card.key]?.year ?? String((card.kind === "file" ? card.source.year : card.found.album.year) ?? "");

  /**
   * PAR-UP-06 (Chris 2026-11-12): who a found album is by: each artist's small round photo (or the drawn picture the
   * library shows for it) and name; a Commons photo's credit under them (PAR-META-15).
   */
  const albumArtists = (found: FoundAlbum) => {
    const artists = parrotAlbumArtists(found.album);
    const credited = artists.flatMap((artist) => {
      const credit = artist.id ? photos[artist.id] : undefined;
      return credit?.photo && credit.credit ? [{ key: artist.id ?? artist.name, credit: credit.credit }] : [];
    });
    return (
      <div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" data-testid="import-match-artists">
          {artists.map((artist) => {
            const photo = artist.id ? photos[artist.id] : undefined;
            return (
              <span
                key={artist.id ?? artist.name}
                className="flex min-w-0 items-center gap-2"
                data-testid="import-match-artist"
                data-artist={artist.name}
                data-photo={artist.id && !photo ? "loading" : photo?.photo ? "found" : "none"}
              >
                <span className="h-7 w-7 shrink-0">
                  <ParrotCover seed={artist.id ?? artist.name} src={photo?.photo ?? null} className="w-full shadow-none" rounded="rounded-full" />
                </span>
                <span className="truncate text-foreground">{artist.name}</span>
              </span>
            );
          })}
          {found.album.year ? <span data-testid="import-match-year">{found.album.year}</span> : null}
        </div>
        {credited.map(({ key, credit }) => (
          <ParrotPhotoCreditLine key={key} credit={credit} creditLabel={(author, licence) => t("library.photoCredit", { author, licence })} className="mt-1 text-left" />
        ))}
      </div>
    );
  };

  /** The cover is the picker (Chris v3): a click, Enter or Space opens its menu; hover and focus say what it does. */
  const coverPicker = (card: Card) => {
    const shown = coverOf(card);
    const pictures = picturesOf[card.key];
    const choose = (picture: ParrotImportPicture | null) => {
      console.info(`[import-review] ${card.key} cover: ${picture ? `${picture.id} (${picture.width} × ${picture.height})` : "its own"}`);
      setCovers((previous) => ({ ...previous, [card.key]: { picture, crop: null } }));
      setCoverMenu(false);
    };
    return (
      <div className="relative w-40 shrink-0">
        <button
          type="button"
          aria-label={t("import.cover.change")}
          aria-haspopup="menu"
          aria-expanded={coverMenu}
          className={`group relative block w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
            coverMenu ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : ""
          }`}
          onClick={() => setCoverMenu((open) => !open)}
          data-testid="import-cover-button"
          data-framed={shown.crop ? "true" : undefined}
        >
          <FramedCover src={shown.src} crop={shown.crop} className="aspect-square w-full rounded-lg shadow-lg" />
          <span
            className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-lg bg-black/55 text-sm font-medium text-white transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${
              coverMenu ? "opacity-100" : "opacity-0"
            }`}
          >
            <ImageUp className="h-5 w-5" aria-hidden />
            {t("import.cover.change")}
          </span>
        </button>
        {coverMenu ? (
          <>
            <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setCoverMenu(false)} />
            <div
              role="menu"
              className="absolute left-0 top-full z-50 mt-2 w-80 space-y-3 rounded-xl border border-border bg-popover p-3 text-sm shadow-xl"
              onKeyDown={(event) => event.key === "Escape" && setCoverMenu(false)}
              data-testid="import-cover-menu"
            >
              {card.kind === "library" && card.found.cover ? (
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/40"
                  onClick={() => choose(null)}
                  data-testid="import-cover-library"
                >
                  <img src={card.found.cover} alt="" className="h-8 w-8 rounded object-cover" />
                  {t("import.cover.library")}
                </button>
              ) : null}
              <div className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                {pictures === undefined ? <Spinner size="sm" /> : pictures.length ? t("import.cover.pictures", { n: pictures.length }) : t("import.cover.noPictures")}
              </div>
              {pictures?.length ? (
                <div className="flex flex-wrap gap-2">
                  {pictures.map((picture) => (
                    <button
                      key={picture.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={shown.picture?.id === picture.id}
                      aria-label={`${picture.width} × ${picture.height}`}
                      title={`${picture.width} × ${picture.height}`}
                      className={`h-16 w-16 overflow-hidden rounded-md border-2 ${shown.picture?.id === picture.id ? "border-primary" : "border-transparent hover:border-input"}`}
                      onClick={() => choose(picture)}
                      data-testid="import-cover-picture"
                    >
                      <img src={picture.data} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/40"
                onClick={async () => {
                  setCoverMenu(false);
                  const picture = await window.parrot.pickImportCoverImage().catch((error: unknown) => {
                    console.warn("[import-review] image pick failed", error);
                    return null;
                  });
                  if (!picture) return;
                  setPicturesOf((previous) => ({ ...previous, [card.key]: [picture, ...(previous[card.key] ?? []).filter((other) => other.id !== picture.id)] }));
                  choose(picture);
                }}
                data-testid="import-cover-choose"
              >
                <ImageUp className="h-4 w-4" aria-hidden />
                {t("import.cover.choose")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!shown.src}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/40 disabled:opacity-50"
                onClick={() => {
                  setCoverMenu(false);
                  setFraming(card.key);
                }}
                data-testid="import-cover-frame"
              >
                <CropIcon className="h-4 w-4" aria-hidden />
                {t("import.cover.frame")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  /** A strip under the album's names: still looking up (with "Import as is"), found nothing, or could not ask. */
  const strip = (card: Card) => {
    if (card.state === "searching") {
      return (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm" data-testid="import-lookup-strip" data-state="searching">
          <Spinner size="sm" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t("import.lookup.searchingTitle")}</div>
            <div className="text-muted-foreground">{t("import.lookup.searchingHint")}</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => stopLookup(card)} data-testid="import-lookup-as-is">
            {t("import.lookup.asIs")}
          </Button>
        </div>
      );
    }
    if (card.state === "notfound" || card.state === "failed") {
      return (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm" data-testid="import-lookup-strip" data-state={card.state}>
          {card.state === "failed" ? <WifiOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <SearchX className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t(card.state === "failed" ? "import.lookup.failed" : "import.lookup.notFound")}</div>
            <div className="text-muted-foreground">{t(card.state === "failed" ? "import.lookup.failedHint" : "import.lookup.notFoundHint")}</div>
          </div>
        </div>
      );
    }
    return null;
  };

  /** One song row: its untick box, its number, its name to change, its file and length; a file album's row drags. */
  const songRow = (card: Card, entry: ParrotScanEntry, index: number, number: string) => {
    const on = !unticked.has(entry.file);
    const title = named(entry, card).title;
    const movable = card.kind === "file";
    return (
      <div
        key={entry.file}
        className={`grid grid-cols-[1.25rem_1.25rem_1.75rem_1fr_2.75rem] items-center gap-2 border-b border-border/30 px-3 py-1.5 last:border-b-0 ${dragging === entry.file ? "opacity-40" : ""} ${on ? "" : "opacity-60"}`}
        onDragOver={
          movable && dragging
            ? (event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setDropAt(index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0));
              }
            : undefined
        }
        onDrop={
          movable && dragging
            ? (event) => {
                event.preventDefault();
                if (dropAt !== null) moveSong(card, dragging, dropAt);
                setDragging(null);
                setDropAt(null);
              }
            : undefined
        }
        data-testid="import-review-song"
        data-file={entry.file}
        data-track={number}
        data-sure={card.kind === "library" ? String(places[entry.file]?.sure ?? true) : undefined}
      >
        {movable ? (
          <span
            role="button"
            tabIndex={0}
            draggable
            aria-label={t("import.review.move", { title })}
            className="cursor-grab text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", entry.file);
              const row = event.currentTarget.parentElement;
              if (row) event.dataTransfer.setDragImage(row, 12, row.clientHeight / 2);
              setDragging(entry.file);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropAt(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              moveSong(card, entry.file, event.key === "ArrowUp" ? index - 1 : index + 2);
            }}
            data-testid="import-song-grip"
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </span>
        ) : (
          <span />
        )}
        <Checkbox checked={on} aria-label={title} onCheckedChange={(next) => setTicked([entry.file], next)} data-testid="import-review-check" />
        <span className="text-right text-sm tabular-nums text-muted-foreground" data-testid="import-song-number">
          {number}
        </span>
        <div className="min-w-0">
          <div className="group relative">
            <Input
              value={title}
              onChange={(event) => setTyped((previous) => ({ ...previous, [entry.file]: event.target.value }))}
              aria-label={t("import.review.songName", { n: number })}
              className={`h-9 pr-9 ${FIELD_LOOK}`}
              data-testid="import-song-title"
            />
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted-foreground">
              <Pencil className="h-3.5 w-3.5 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" aria-hidden />
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={entry.file}>
            {fileName(entry.file)}
          </div>
        </div>
        <span className="text-right text-xs tabular-nums text-muted-foreground">{duration(entry.durationMs)}</span>
      </div>
    );
  };
  const dropLine = (at: number) => (dragging && dropAt === at ? <div key={`drop-${at}`} className="mx-3 my-0.5 h-0.5 rounded-full bg-primary" data-testid="import-drop-line" /> : null);

  const songsBox = (card: Card) => {
    if (card.kind === "file") {
      const numberOf = (entry: ParrotScanEntry) => slotOf.get(entry.file)?.number ?? 0;
      return (
        <div className="space-y-2" data-testid="import-songs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{t("import.review.songsCount", { n: card.files.length })}</span>
            <span className="ml-auto text-xs text-muted-foreground">{t("import.review.dragHint")}</span>
          </div>
          <div className="rounded-lg border border-border/60" onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropAt(null)}>
            {card.files.map((entry, index) => [dropLine(index), songRow(card, entry, index, numberOf(entry) > 0 ? String(numberOf(entry)) : "–")])}
            {dropLine(card.files.length)}
          </div>
        </div>
      );
    }
    const { found } = card;
    const byTrack = new Map(card.files.filter((entry) => places[entry.file]?.number != null).map((entry) => [trackKey(places[entry.file] as { disc: number; number: number }), entry]));
    const added = card.files.filter((entry) => places[entry.file]?.number == null);
    return (
      <div className="space-y-2" data-testid="import-match-tracks">
        <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{t("import.match.tracks", { n: found.album.tracks.length })}</span>
        <div className="rounded-lg border border-border/60">
          {found.album.tracks.map((track, index) => {
            const entry = byTrack.get(trackKey(track));
            return entry ? (
              songRow(card, entry, index, String(track.number))
            ) : (
              <div
                key={trackKey(track)}
                className="grid grid-cols-[1.25rem_1.25rem_1.75rem_1fr_2.75rem] items-center gap-2 border-b border-border/30 px-3 py-2 text-sm text-muted-foreground/60 last:border-b-0"
                data-testid="import-match-track-missing"
                data-track={String(track.number)}
              >
                <span />
                <span />
                <span className="text-right tabular-nums">{track.number}</span>
                <div className="min-w-0">
                  <div className="truncate">{track.title}</div>
                  <div className="text-[11px]">{t("import.match.notImported")}</div>
                </div>
                <span className="text-right text-xs tabular-nums">{duration(track.durationMs ?? null)}</span>
              </div>
            );
          })}
          {added.map((entry, index) => songRow(card, entry, found.album.tracks.length + index, "+"))}
        </div>
      </div>
    );
  };

  const cleanupText = ({ rule, text, count }: ParrotTitleCleanupApplied) => {
    if (rule === "full-album") return t("import.cleanup.album", { text });
    const plural = new Intl.PluralRules(language).select(count) === "one" ? "one" : "other";
    return t(`import.cleanup.${rule === "artist-prefix" ? "start" : "end"}.${plural}`, { text, n: count });
  };

  /** PAR-META-23: what the review took off a file album's names, each with its own Undo (and Redo once undone). */
  const cleanupNotice = (card: Card) => {
    if (card.kind !== "file") return null;
    const albumKey = card.source.key;
    const proposed = cleanups.get(albumKey)?.proposed ?? [];
    if (proposed.length === 0) return null;
    const skipped = undone[albumKey] ?? new Set<ParrotTitleCleanupRule>();
    const toggle = (rule: ParrotTitleCleanupRule) => {
      const next = new Set(skipped);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      console.info(`[import-review] album ${JSON.stringify(card.source.title)}: clean-up ${rule} ${next.has(rule) ? "undone" : "redone"}`);
      setUndone((previous) => ({ ...previous, [albumKey]: next }));
    };
    return (
      <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2" data-testid="import-cleanups">
        <div className="text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground">{t("import.cleanup.title")}</div>
        {proposed.map((applied) => {
          const off = skipped.has(applied.rule);
          return (
            <div key={applied.rule} className="flex items-center gap-3 text-sm" data-testid="import-cleanup" data-rule={applied.rule} data-undone={off ? "true" : undefined}>
              <Eraser className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className={`min-w-0 flex-1 ${off ? "text-muted-foreground line-through" : ""}`}>{cleanupText(applied)}</span>
              <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => toggle(applied.rule)} data-testid="import-cleanup-undo">
                {t(off ? "import.cleanup.redo" : "import.cleanup.undo")}
              </Button>
            </div>
          );
        })}
      </div>
    );
  };

  const searchingDetail = (card: Card) => (
    <div className="space-y-5" data-testid="import-album-detail" data-state="searching">
      <div className="flex gap-5">
        <FramedCover src={coverOf(card).src} crop={null} className="aspect-square w-36 shrink-0 rounded-lg shadow-lg" />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
            <Disc3 className="h-3.5 w-3.5" aria-hidden />
            {t("import.match.album")}
          </div>
          <div className="text-2xl font-semibold">{cardTitle(card)}</div>
          <div className="text-sm text-muted-foreground">{[cardArtist(card), cardYear(card)].filter(Boolean).join(" · ")}</div>
          <div className="text-sm text-muted-foreground">
            {countText(language, t, "song", card.files.length)} · {formatLocalizedStorage(card.files.reduce((sum, entry) => sum + entry.size, 0), language)}
          </div>
        </div>
      </div>
      {strip(card)}
      {cleanupNotice(card)}
      <div className="rounded-lg border border-border/60">
        {card.files.map((entry) => (
          <div key={entry.file} className="flex items-center gap-3 border-b border-border/30 px-3 py-2 text-sm last:border-b-0" data-testid="import-review-song" data-file={entry.file}>
            <Checkbox checked={!unticked.has(entry.file)} aria-label={entry.title} onCheckedChange={(next) => setTicked([entry.file], next)} data-testid="import-review-check" />
            <span className="w-6 text-right tabular-nums text-muted-foreground">{entry.number || ""}</span>
            <div className="min-w-0 flex-1 truncate">{entry.title}</div>
            <span className="text-xs tabular-nums text-muted-foreground">{duration(entry.durationMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const albumDetail = (card: Card) => {
    if (card.state === "searching") return searchingDetail(card);
    const check = card.kind === "library" && card.files.some((entry) => !places[entry.file]?.sure) && !confirmed.has(parrotAlbumKey(card.found.album));
    return (
      <div className="space-y-5" data-testid="import-album-detail" data-state={card.state} data-album={cardTitle(card)}>
        <div className="flex gap-5">
          {coverPicker(card)}
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
              <Disc3 className="h-3.5 w-3.5" aria-hidden />
              {t("import.match.album")}
              <span className="normal-case tracking-normal">
                <SourcePill t={t} library={card.kind === "library"} />
              </span>
            </div>
            <PencilField label={t("import.review.album")} value={cardTitle(card)} onChange={(value) => typeAlbum(card, "album", value)} testId="import-field-album" big />
            <div className="flex gap-3">
              <ArtistField
                key={card.key}
                t={t}
                id={card.key.replace(/[^a-z0-9]/gi, "")}
                value={cardArtist(card)}
                album={cardTitle(card)}
                suggest={suggest}
                onChange={(value) => typeAlbum(card, "artist", value)}
                onPick={(artist, album) => {
                  console.info(`[import-review] ${card.key} artist picked from the suggestions`);
                  setAlbumTyped((previous) => ({ ...previous, [card.key]: { ...previous[card.key], artist, ...(album ? { album } : {}) } }));
                }}
              />
              <PencilField label={t("import.review.year")} value={cardYear(card)} onChange={(value) => typeAlbum(card, "year", value)} testId="import-field-year" className="w-28" numeric />
            </div>
            <div className="text-sm text-muted-foreground">
              {countText(language, t, "song", card.files.length)} · {formatLocalizedStorage(card.files.reduce((sum, entry) => sum + entry.size, 0), language)}
            </div>
          </div>
        </div>
        {card.kind === "library" ? (
          <div className="space-y-3" data-testid="import-match-album" data-album={card.found.album.title}>
            {albumArtists(card.found)}
            {check ? <ImportReviewNoMatch icon={<AlertCircle className="h-4 w-4" />} title={t("import.match.check")} hint={t("import.match.checkHint")} data-testid="import-match-check" /> : null}
            <div className="flex flex-wrap gap-2">
              {check ? (
                <Button
                  size="sm"
                  onClick={() => {
                    console.info(`[import-review] match ${card.key} confirmed by the user`);
                    setConfirmed((previous) => new Set(previous).add(parrotAlbumKey(card.found.album)));
                  }}
                  data-testid="import-match-confirm"
                >
                  {t("import.match.looksRight")}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => clearMatch(card)} data-testid="import-match-clear">
                {t("import.match.clear")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {strip(card)}
            {cleanupNotice(card)}
          </>
        )}
        {songsBox(card)}
        <AlbumSearch key={card.key} t={t} label={t("import.match.search")} artist={cardArtist(card)} album={cardTitle(card)} onChoose={(picked) => chooseAlbum(card, picked)} />
      </div>
    );
  };

  const framingCard = framing ? cards.find((card) => card.key === framing) : undefined;
  const framingCover = framingCard ? coverOf(framingCard) : null;

  return (
    <ImportReviewDialog
      open
      onOpenChange={(open) => {
        if (!open && !framing) void cancel();
      }}
      title={t("import.review.heading")}
      data-testid="import-review"
      // PAR-TOUR-01 step 2: the first-open tour shows its card in this dialog.
      data-tour="import-review"
    >
      <ImportReviewBody>
        {scan.entries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">{t("import.review.empty")}</div>
        ) : (
          <>
            <ImportReviewList data-testid="import-review-list">
              {/* Only the box ticks or unticks every song; its words do nothing (Chris 2026-11-11). */}
              <div className="flex items-center gap-3 border-b border-border/50 px-4 py-3 text-sm">
                <Checkbox
                  checked={importing.length === scan.entries.length}
                  aria-label={t("import.review.all")}
                  onCheckedChange={(on) => setTicked(scan.entries.map((entry) => entry.file), on)}
                  data-testid="import-review-all"
                />
                <span data-testid="import-review-all-label">{t("import.review.all")}</span>
              </div>
              {cards.map((card) => {
                const paths = card.files.map((entry) => entry.file);
                const shown = coverOf(card);
                const check = card.kind === "library" && card.files.some((entry) => !places[entry.file]?.sure) && !confirmed.has(parrotAlbumKey(card.found.album));
                const onTracks = card.kind === "library" ? card.files.filter((entry) => places[entry.file]?.number != null).length : 0;
                const incomplete = card.kind === "library" && card.found.tracklistKnown && onTracks < card.found.album.tracks.length;
                const year = cardYear(card);
                return (
                  <ImportReviewRow
                    key={card.key}
                    selected={current?.key === card.key}
                    onSelect={() => select(card)}
                    icon={<FramedCover src={shown.src} crop={shown.crop} className="h-10 w-10 shrink-0 rounded" />}
                    title={cardTitle(card)}
                    titleText={cardTitle(card)}
                    data-testid="import-review-album"
                    data-state={card.state}
                    data-match={card.kind === "library" ? "found" : undefined}
                    data-album={cardTitle(card)}
                    trailing={
                      <Checkbox
                        checked={paths.every((file) => !unticked.has(file))}
                        aria-label={cardTitle(card)}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={(next) => setTicked(paths, next)}
                        data-testid="import-review-album-check"
                      />
                    }
                  >
                    <div className="mt-1 truncate text-xs text-muted-foreground">{[cardArtist(card), year].filter(Boolean).join(" · ")}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {card.state === "searching" ? (
                        <>
                          <ImportReviewBadge data-testid="import-album-looking">
                            <span className="inline-flex items-center gap-1.5">
                              <Spinner size="sm" />
                              {t("import.lookup.looking")}
                            </span>
                          </ImportReviewBadge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            onClick={(event) => {
                              event.stopPropagation();
                              stopLookup(card);
                            }}
                            data-testid="import-album-as-is"
                          >
                            {t("import.lookup.asIs")}
                          </Button>
                        </>
                      ) : (
                        <SourcePill t={t} library={card.kind === "library"} />
                      )}
                      {check ? (
                        <ImportReviewBadge tone="attention" data-testid="import-album-check">
                          {t("import.match.check")}
                        </ImportReviewBadge>
                      ) : null}
                      {incomplete && card.kind === "library" ? (
                        <ImportReviewBadge data-testid="import-album-incomplete">{t("import.match.incomplete", { have: onTracks, total: card.found.album.tracks.length })}</ImportReviewBadge>
                      ) : null}
                    </div>
                  </ImportReviewRow>
                );
              })}
              {scan.unreadable.length > 0 ? (
                <ImportReviewSection tone="attention" data-testid="import-review-unreadable">
                  {t("import.review.unreadable", { n: scan.unreadable.length })}
                </ImportReviewSection>
              ) : null}
            </ImportReviewList>
            <ImportReviewDetail>{current ? albumDetail(current) : null}</ImportReviewDetail>
          </>
        )}
      </ImportReviewBody>
      <ImportReviewFooter>
        <ImportReviewSummary data-testid="import-review-summary">
          {t("import.review.summary", { selected: importing.length, total: scan.entries.length, size: formatLocalizedStorage(importingBytes, language) })}
          {looking > 0 ? (
            <div className="text-xs" data-testid="import-review-still-looking">
              {t(looking === 1 ? "import.review.stillLooking.one" : "import.review.stillLooking.other", { n: looking })}
            </div>
          ) : null}
        </ImportReviewSummary>
        <ImportReviewActions>
          <Button variant="ghost" disabled={busy} onClick={() => void cancel()} data-testid="import-review-cancel">
            {t("import.review.cancel")}
          </Button>
          <Button disabled={busy || importing.length === 0 || looking > 0} onClick={() => void confirm()} data-testid="import-review-confirm">
            {t(`import.review.confirm.${new Intl.PluralRules(language).select(importing.length) === "one" ? "one" : "other"}`, { n: importing.length })}
          </Button>
        </ImportReviewActions>
      </ImportReviewFooter>
      {framingCard && framingCover?.src ? (
        <ParrotCoverFrameDialog
          key={framingCard.key}
          labels={coverFrameLabels(t)}
          testId="import-frame"
          src={framingCover.src}
          size={framingCover.picture ? { width: framingCover.picture.width, height: framingCover.picture.height } : null}
          crop={framingCover.crop}
          onCancel={() => setFraming(null)}
          onUse={(crop) => {
            console.info(`[import-review] ${framingCard.key} cover framed: ${crop ? `${crop.left.toFixed(3)},${crop.top.toFixed(3)} × ${crop.size.toFixed(3)}` : "centre"}`);
            setCovers((previous) => ({ ...previous, [framingCard.key]: { picture: previous[framingCard.key]?.picture ?? null, crop } }));
            setFraming(null);
          }}
        />
      ) : null}
    </ImportReviewDialog>
  );
}

/**
 * "Wrong album? Search" (PAR-UP-05): the user types an artist and an album, our music library answers a few albums
 * with their covers, and Select puts the card's songs on the picked album.
 */
function AlbumSearch({ t, label, artist: startArtist, album: startAlbum, onChoose }: { t: Translate; label: string; artist: string; album: string; onChoose: (found: ParrotImportFoundAlbum) => void }) {
  const [open, setOpen] = useState(false);
  const [artist, setArtist] = useState(startArtist);
  const [album, setAlbum] = useState(startAlbum);
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<ParrotImportAlbumSearch | null>(null);
  const withCover = useSearchCovers(answer);

  const search = async () => {
    if (searching || (!artist.trim() && !album.trim())) return;
    setSearching(true);
    const found = await window.parrot.searchImportAlbums({ artist, album }).catch((error: unknown) => {
      console.warn("[import-review] album search failed", error);
      return { kind: "failed" } as const;
    });
    console.info(`[import-review] album search: ${found.kind === "found" ? `${found.results.length} result(s)` : "failed"}`);
    setAnswer(found);
    setSearching(false);
  };
  const choose = (found: ParrotImportFoundAlbum) => {
    onChoose(found);
    setAnswer(null);
    setOpen(false);
  };

  return (
    <ImportReviewMatchSearch
      open={open}
      onOpenChange={setOpen}
      label={label}
      data-testid="import-match-search"
      controls={
        <>
          <Input
            value={artist}
            onChange={(event) => setArtist(event.target.value)}
            placeholder={t("import.review.artist")}
            aria-label={t("import.review.artist")}
            className="flex-1"
            onKeyDown={(event) => event.key === "Enter" && void search()}
            data-testid="import-match-search-artist"
          />
          <Input
            value={album}
            onChange={(event) => setAlbum(event.target.value)}
            placeholder={t("import.review.album")}
            aria-label={t("import.review.album")}
            className="flex-1"
            onKeyDown={(event) => event.key === "Enter" && void search()}
            data-testid="import-match-search-album"
          />
          <Button variant="secondary" onClick={() => void search()} disabled={searching} data-testid="import-match-search-submit">
            {searching ? <Spinner size="sm" /> : t("import.match.searchGo")}
          </Button>
          {answer ? (
            <Button variant="ghost" onClick={() => setAnswer(null)}>
              {t("import.match.searchClear")}
            </Button>
          ) : null}
        </>
      }
    >
      {searching ? (
        <ImportReviewSearching className="mt-4" icon={<Spinner size="sm" />} title={t("manage.searching")} data-testid="import-match-search-searching" />
      ) : answer?.kind === "failed" ? (
        <p className="mt-4 text-sm text-amber-300" data-testid="import-match-search-failed">
          {t("import.match.searchFailed")}
        </p>
      ) : answer?.results.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="import-match-search-none">
          {t("import.match.searchNone")}
        </p>
      ) : answer ? (
        <div className="mt-4 grid grid-cols-2 gap-4 pb-2 md:grid-cols-4">
          {answer.results.map(withCover).map((found) => (
            <ImportReviewMatchResult
              key={parrotAlbumKey(found.album)}
              artworkShape="square"
              artwork={<FramedCover src={found.cover} crop={null} className="h-full w-full" />}
              title={found.album.title}
              meta={[found.album.artist.name, found.album.year].filter(Boolean).join(" · ")}
              selectLabel={t("import.match.select")}
              onSelect={() => choose(found)}
              data-testid="import-match-result"
            />
          ))}
        </div>
      ) : null}
    </ImportReviewMatchSearch>
  );
}
