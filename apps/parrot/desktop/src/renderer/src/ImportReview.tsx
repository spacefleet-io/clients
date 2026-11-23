import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Disc3 } from "lucide-react";
import {
  Button,
  Checkbox,
  ImportReviewActions,
  ImportReviewBadge,
  ImportReviewBlocked,
  ImportReviewBody,
  ImportReviewDetail,
  ImportReviewDialog,
  ImportReviewFooter,
  ImportReviewItem,
  ImportReviewItems,
  ImportReviewList,
  ImportReviewMatchHeader,
  ImportReviewMatchResult,
  ImportReviewMatchSearch,
  ImportReviewNoMatch,
  ImportReviewSearching,
  ImportReviewRow,
  ImportReviewSection,
  ImportReviewSummary,
  Input,
  Spinner,
} from "@space/ui";
import { ParrotCover } from "@space/ui/parrot";
import { ParrotPhotoCreditLine } from "@space/ui/parrot/library";
import { formatLocalizedStorage } from "@space/shared/format";
import type { MusicAlbumTrack } from "@space/shared/api";
import { matchParrotImportTracks, parrotAlbumArtists, parrotAlbumKey, parrotImportFromMatch, type ParrotImportUnidentifiedReason } from "@space/parrot-core";
import type {
  ParrotImportAlbumSearch,
  ParrotImportArtistPhoto,
  ParrotImportEdit,
  ParrotImportFoundAlbum,
  ParrotImportMatchResult,
  ParrotImportScan,
  ParrotImportSongSearch,
  ParrotLanguage,
  ParrotScanEntry,
} from "../../shared/ipc";
import type { ParrotStringKey, Translate } from "./i18n";

type Props = { t: Translate; language: ParrotLanguage; scan: ParrotImportScan; onDone: () => void };

type NameField = "title" | "artist" | "album";
const NAME_FIELDS: readonly NameField[] = ["title", "artist", "album"];
/** An album songs are placed on, with whether its tracklist is whole (false: the album lookup failed). */
type FoundAlbum = ParrotImportFoundAlbum & { tracklistKnown: boolean };
/** Where a song goes: a track of an album (`number` null: added by the user, not on the tracklist). */
type Place = { albumKey: string; disc: number; number: number | null; sure: boolean };
/** What the user decided for an unidentified song. */
type Fate = "keep" | "drop";
/** The left list's row for the songs matched to nothing. */
const UNIDENTIFIED = "unidentified";
/** The metadata's id of "Various Artists", the album artist of a compilation whose songs each keep their own artist. */
const VARIOUS_ARTISTS_ID = "89ad4ac3-39f7-470e-963a-56509c546377";

const REASON_TEXT: Record<ParrotImportUnidentifiedReason, ParrotStringKey> = {
  "no-match": "import.unidentified.noMatch",
  "no-names": "import.unidentified.noNames",
  "no-track": "import.unidentified.noTrack",
  "lookup-failed": "import.unidentified.lookupFailed",
};

const trackKey = (track: { disc: number; number: number }) => `${track.disc}:${track.number}`;
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
/** The album's artists' names, as its row and header say them ("Linnet Park & Jun-O"). */
const artistNames = (found: ParrotImportFoundAlbum) => parrotAlbumArtists(found.album).map((artist) => artist.name).join(" & ");
/** The left list's order: by artist, then year, then title. */
const albumOrder = (a: ParrotImportFoundAlbum, b: ParrotImportFoundAlbum) =>
  artistNames(a).localeCompare(artistNames(b)) || (a.album.year ?? 0) - (b.album.year ?? 0) || a.album.title.localeCompare(b.album.title);

/** An album's cover, or a disc when it has none. */
const albumArt = (found: ParrotImportFoundAlbum | undefined, className: string) =>
  found?.cover ? (
    <img src={found.cover} alt="" className={className} />
  ) : (
    <div className={`${className} flex items-center justify-center bg-muted`}>
      <Disc3 className="h-1/2 w-1/2 text-muted-foreground" aria-hidden />
    </div>
  );

/** How many covers the dialog asks at once: the service spaces its own calls to each cover source (META-PUB-02). */
const IMPORT_COVER_LANES = 3;

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
function useSearchCovers(answer: { kind: "found"; results: ParrotImportFoundAlbum[] } | { kind: "failed" } | null) {
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

/**
 * "Here's what I found in your music folder" (PAR-UP-05, Chris 2026-11-11): each song the scan found is matched on
 * its own against our music library and grouped under the album it really is on (a Meltway-tagged "At the Gate" lands
 * under Hollow Signal, a live take under its live release). An album row marks a match to check ("Check") and an
 * incomplete album ("8 of 10 tracks"); its details show its full tracklist, the missing tracks greyed. Songs matched
 * to nothing wait in "Unidentified", each to identify, keep as is or drop; Import waits until each has one. The user
 * unticks songs and picks one to fix its names (a typed name wins over the automatic match; a song or album the user
 * then picks with Identify or "Add to album…" replaces it). Import uploads only the ticked songs with the album's full
 * tracklist, album artist and cover; Cancel uploads nothing. Built on the family's import review (REL-FAM-02).
 */
export default function ImportReview({ t, language, scan, onDone }: Props) {
  /** Only the names the user typed, per song: a typed name (even emptied) wins over the match and the tags. */
  const [typed, setTyped] = useState<Record<string, Partial<Record<NameField, string>>>>({});
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  /** The lookup's answer has come (the list shows nothing before: songs would jump between albums). */
  const [matched, setMatched] = useState(false);
  const [albums, setAlbums] = useState<Record<string, FoundAlbum>>({});
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [reasons, setReasons] = useState<Record<string, ParrotImportUnidentifiedReason>>({});
  const [fates, setFates] = useState<Record<string, Fate>>({});
  /** Albums whose "Check" the user answered with "Looks right". */
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  /** The row whose details show (an album's key, or UNIDENTIFIED), and the song picked in them. */
  const [selected, setSelected] = useState<string | null>(null);
  const [song, setSong] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The matched artists' photos (PAR-UP-06), by their id in the metadata; an artist not in it yet is still being asked. */
  const [photos, setPhotos] = useState<Record<string, ParrotImportArtistPhoto>>({});
  const askedPhotos = useRef(new Set<string>());

  const entries = useMemo(() => new Map(scan.entries.map((entry) => [entry.file, entry])), [scan]);

  useEffect(() => {
    console.info(`[import-review] showing ${scan.entries.length} song(s), ${scan.unreadable.length} unreadable; matching each song`);
    let live = true;
    const show = (result: ParrotImportMatchResult) => {
      if (!live) return;
      const unsure = result.albums.filter((found) => found.files.some((file) => !file.sure)).length;
      console.info(`[import-review] match: ${result.albums.length} album(s) (${unsure} to check), ${result.unidentified.length} unidentified`);
      setAlbums(Object.fromEntries(result.albums.map(({ files: _files, ...found }) => [parrotAlbumKey(found.album), found])));
      setPlaces(
        Object.fromEntries(
          result.albums.flatMap((found) => found.files.map((file) => [file.file, { albumKey: parrotAlbumKey(found.album), disc: file.disc, number: file.number, sure: file.sure }]))
        )
      );
      setReasons(Object.fromEntries(result.unidentified.map((file) => [file.file, file.reason])));
      // A song the lookup could not be asked about is kept as is: a lookup that is down never stops the import.
      setFates(Object.fromEntries(result.unidentified.filter((file) => file.reason === "lookup-failed").map((file) => [file.file, "keep" as const])));
      // The first album in the list opens first (as the list orders them).
      const first = [...result.albums].sort(albumOrder)[0];
      setSelected(first ? parrotAlbumKey(first.album) : result.unidentified.length > 0 ? UNIDENTIFIED : null);
      setMatched(true);
      // The covers come after the list (#2509): a few at a time in the list's order (`askCovers`), each drawn as it
      // comes; the disc shows meanwhile.
      const keysOf = new Map<string, string[]>();
      for (const found of [...result.albums].sort(albumOrder)) {
        const id = found.album.id;
        if (found.cover || !id) continue;
        keysOf.set(id, [...(keysOf.get(id) ?? []), parrotAlbumKey(found.album)]);
      }
      void askCovers([...keysOf.keys()], () => live, (id, cover) => {
        if (!cover) return;
        setAlbums((previous) => {
          const next = { ...previous };
          for (const key of keysOf.get(id) ?? []) if (next[key] && !next[key].cover) next[key] = { ...next[key], cover };
          return next;
        });
      });
    };
    void window.parrot.matchImport().then(show, (error: unknown) => {
      console.warn("[import-review] match failed", error);
      show({ albums: [], unidentified: scan.entries.map((entry) => ({ file: entry.file, reason: "lookup-failed" })) });
    });
    return () => {
      live = false;
    };
  }, [scan]);

  /** The albums songs are placed on, each with its songs in tracklist order (added songs last). */
  const groups = useMemo(() => {
    const byAlbum = new Map<string, ParrotScanEntry[]>();
    for (const [file, place] of Object.entries(places)) {
      const entry = entries.get(file);
      if (entry) byAlbum.set(place.albumKey, [...(byAlbum.get(place.albumKey) ?? []), entry]);
    }
    const order = (entry: ParrotScanEntry) => {
      const place = places[entry.file];
      return place.number === null ? Number.MAX_SAFE_INTEGER : place.disc * 10_000 + place.number;
    };
    return [...byAlbum.entries()]
      .filter(([albumKey]) => albums[albumKey])
      .map(([albumKey, files]) => ({ found: albums[albumKey], files: files.sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title)) }))
      .sort((a, b) => albumOrder(a.found, b.found));
  }, [places, albums, entries]);
  /** Every matched album's artists (PAR-UP-06), each once: their photos are asked for the album headers. */
  const artistIds = [...new Set(groups.flatMap((group) => parrotAlbumArtists(group.found.album).flatMap((artist) => (artist.id ? [artist.id] : []))))].join(",");

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
  const unidentified = matched ? scan.entries.filter((entry) => !places[entry.file]) : [];

  /** The album track a song is placed on, if any. */
  const trackOf = (file: string): { found: FoundAlbum; track: MusicAlbumTrack | null } | null => {
    const place = places[file];
    const found = place ? albums[place.albumKey] : undefined;
    if (!place || !found) return null;
    const track = place.number === null ? null : (found.album.tracks.find((candidate) => candidate.disc === place.disc && candidate.number === place.number) ?? null);
    return { found, track };
  };

  /**
   * What the import stores for a song: typed names, else the matched track's, else the tags. A matched song takes the
   * release's album artist (a "Various Artists" tag stands only when the match is itself a various-artists
   * compilation, whose songs keep their own artist) and the cover the review shows (PAR-META-04).
   */
  const named = (entry: ParrotScanEntry): ParrotImportEdit => {
    const own = typed[entry.file] ?? {};
    const placed = trackOf(entry.file);
    if (!placed) {
      return {
        title: own.title ?? entry.title,
        artist: own.artist ?? entry.artist,
        album: own.album ?? entry.album,
        ...(fates[entry.file] === "keep" ? { unidentified: true } : {}),
      };
    }
    const { album, tracklistKnown, cover } = placed.found;
    const fill = placed.track ? parrotImportFromMatch(album, placed.track) : null;
    const variousArtists = album.artist.id === VARIOUS_ARTISTS_ID || album.artist.name.trim().toLowerCase() === "various artists";
    const coverId = cover ? album.id : null;
    return {
      title: own.title ?? fill?.title ?? entry.title,
      artist: own.artist ?? (variousArtists ? entry.artist : album.artist.name),
      album: own.album ?? album.title,
      albumArtist: variousArtists ? album.artist.name : (own.artist ?? album.artist.name),
      albumArtistMusicId: variousArtists || own.artist === undefined ? album.artist.id : null,
      year: album.year,
      ...(fill ? { number: fill.number, disc: fill.disc } : {}),
      // The album's full tracklist (PAR-LIB-05), only when the album lookup gave it whole.
      ...(tracklistKnown ? { tracklist: album.tracks.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs })) } : {}),
      // The album's id in the metadata (PAR-COPY-01), so later refreshes and the cover pass find it.
      ...(album.id ? { albumMusicId: album.id } : {}),
      ...(coverId ? { coverId } : {}),
    };
  };

  const ticked = scan.entries.filter((entry) => !unticked.has(entry.file));
  const importing = ticked.filter((entry) => fates[entry.file] !== "drop" || places[entry.file]);
  const importingBytes = importing.reduce((sum, entry) => sum + entry.size, 0);
  const undecided = unidentified.filter((entry) => !fates[entry.file] && !unticked.has(entry.file));
  const blocked = !matched ? t("import.match.looking") : undecided.length > 0 ? t("import.review.blocked", { n: undecided.length }) : null;

  const setTicked = (files: string[], on: boolean) =>
    setUnticked((previous) => {
      const next = new Set(previous);
      for (const file of files) {
        if (on) next.delete(file);
        else next.add(file);
      }
      return next;
    });
  const setFate = (files: string[], fate: Fate) => {
    console.info(`[import-review] ${files.length} unidentified song(s): ${fate === "keep" ? "kept as is" : "dropped"}`);
    setFates((previous) => ({ ...previous, ...Object.fromEntries(files.map((file) => [file, fate])) }));
  };
  const select = (row: string) => {
    setSelected(row);
    setSong(null);
  };

  /** Puts songs on tracks of an album (the user's choice, so no "Check"); they leave Unidentified. */
  const place = (found: FoundAlbum, files: Array<{ file: string; disc: number; number: number | null }>) => {
    const albumKey = parrotAlbumKey(found.album);
    setAlbums((previous) => ({ ...previous, [albumKey]: previous[albumKey] ?? found }));
    setPlaces((previous) => ({ ...previous, ...Object.fromEntries(files.map(({ file, disc, number }) => [file, { albumKey, disc, number, sure: true }])) }));
    const gone = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([file]) => !files.some((placed) => placed.file === file)));
    setFates((previous) => gone(previous) as Record<string, Fate>);
    setReasons((previous) => gone(previous) as Record<string, ParrotImportUnidentifiedReason>);
  };
  /** Drops the names typed for a song, so the album or track the user picked names it. */
  const forgetTyped = (file: string, fields: readonly NameField[]) =>
    setTyped((previous) => {
      const kept = Object.fromEntries(Object.entries(previous[file] ?? {}).filter(([field]) => !fields.includes(field as NameField)));
      const { [file]: _dropped, ...others } = previous;
      return Object.keys(kept).length > 0 ? { ...others, [file]: kept } : others;
    });
  /** Takes songs off their album: they wait in Unidentified for the user's decision. */
  const unplace = (files: string[], reason?: ParrotImportUnidentifiedReason) => {
    setPlaces((previous) => Object.fromEntries(Object.entries(previous).filter(([file]) => !files.includes(file))));
    if (reason) setReasons((previous) => ({ ...previous, ...Object.fromEntries(files.map((file) => [file, reason])) }));
  };
  /** The tracks of an album already holding a song, but for `except`'s. */
  const takenOn = (albumKey: string, except: string[] = []) =>
    Object.entries(places)
      .filter(([file, placed]) => placed.albumKey === albumKey && placed.number !== null && !except.includes(file))
      .map(([, placed]) => ({ disc: placed.disc, number: placed.number as number }));

  /** "Wrong album? Search": the album's songs move onto the picked album's tracks; one with no track goes to Unidentified. */
  const chooseAlbum = (from: string, files: ParrotScanEntry[], found: ParrotImportFoundAlbum) => {
    const target: FoundAlbum = { ...found, tracklistKnown: true };
    const songs = files.map((entry) => ({ file: entry.file, title: named(entry).title, disc: entry.disc, number: entry.number }));
    const paired = matchParrotImportTracks(songs, target.album, takenOn(parrotAlbumKey(target.album), files.map((entry) => entry.file)));
    const onTracks = [...paired].flatMap(([file, track]) => (track ? [{ file, disc: track.disc, number: track.number as number | null }] : []));
    const off = [...paired].flatMap(([file, track]) => (track ? [] : [file]));
    console.info(`[import-review] album ${from} replaced by search: ${parrotAlbumKey(target.album)}, ${onTracks.length} song(s) on its tracks, ${off.length} to Unidentified`);
    for (const { file } of onTracks) forgetTyped(file, NAME_FIELDS);
    unplace(off, "no-track");
    place(target, onTracks);
    setConfirmed((previous) => new Set(previous).add(parrotAlbumKey(target.album)));
    select(parrotAlbumKey(target.album));
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    console.info("[import-review] cancel: nothing is uploaded");
    await window.parrot.cancelImport();
    onDone();
  };
  const confirm = async () => {
    if (blocked) return;
    setBusy(true);
    const selection = importing.map((entry) => ({ file: entry.file, ...named(entry) }));
    const kept = selection.filter((item) => item.unidentified).length;
    const dropped = ticked.length - importing.length;
    console.info(
      `[import-review] confirm: ${selection.length} of ${scan.entries.length} song(s) on ${groups.length} album(s), ${kept} kept as is, ${dropped} dropped, ${Object.keys(typed).length} edited`
    );
    await window.parrot.confirmImport(selection);
    onDone();
  };

  /** One song in a details box: its untick box, its name, its file. */
  const songItem = (entry: ParrotScanEntry, label: string, sub?: string) => {
    const on = !unticked.has(entry.file);
    const placed = places[entry.file];
    return (
      <ImportReviewItem
        key={entry.file}
        selected={song === entry.file}
        onSelect={() => setSong(entry.file)}
        dimmed={!on}
        leading={<Checkbox checked={on} aria-label={label} onCheckedChange={(next) => setTicked([entry.file], next)} data-testid="import-review-check" />}
        label={label}
        sub={sub ?? fileName(entry.file)}
        data-testid="import-review-song"
        data-file={entry.file}
        data-track={placed?.number != null ? String(placed.number) : undefined}
        data-sure={placed ? String(placed.sure) : undefined}
      />
    );
  };

  /** The picked song's names, under its box. */
  const nameFields = (entry: ParrotScanEntry) => (
    <>
      {NAME_FIELDS.map((field) => (
        <label key={field} className="block space-y-1.5">
          <span className="text-sm font-medium">{t(`import.review.${field}`)}</span>
          <Input
            value={named(entry)[field]}
            onChange={(event) => setTyped((previous) => ({ ...previous, [entry.file]: { ...previous[entry.file], [field]: event.target.value } }))}
            data-testid={`import-review-${field}`}
          />
        </label>
      ))}
      <p className="text-xs text-muted-foreground">{t("import.review.hint")}</p>
    </>
  );

  const songEdit = (entry: ParrotScanEntry) => {
    const placed = trackOf(entry.file);
    return (
      <div className="max-w-md space-y-5" data-testid="import-review-song-edit">
        <div className="truncate text-xs text-muted-foreground" title={entry.file}>
          {fileName(entry.file)} · {formatLocalizedStorage(entry.size, language)}
        </div>
        {placed ? (
          <div className="flex items-center justify-between gap-3 text-sm" data-testid="import-review-song-match">
            <span className="text-primary">
              {placed.track ? t("import.match.track", { number: placed.track.number, title: placed.track.title }) : t("import.match.extra")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.info("[import-review] song taken off its album by the user");
                unplace([entry.file]);
                setSong(null);
              }}
              data-testid="import-review-unplace"
            >
              {t("import.match.notThisSong")}
            </Button>
          </div>
        ) : null}
        {nameFields(entry)}
      </div>
    );
  };

  const albumDetail = (found: FoundAlbum, files: ParrotScanEntry[]) => {
    const albumKey = parrotAlbumKey(found.album);
    const check = files.some((entry) => !places[entry.file].sure) && !confirmed.has(albumKey);
    const byTrack = new Map(files.filter((entry) => places[entry.file].number !== null).map((entry) => [trackKey(places[entry.file] as { disc: number; number: number }), entry]));
    const added = files.filter((entry) => places[entry.file].number === null);
    const current = files.find((entry) => entry.file === song) ?? null;
    return (
      <div className="space-y-6" data-testid="import-match-album" data-album={found.album.title}>
        <ImportReviewMatchHeader
          artworkShape="square"
          artwork={albumArt(found, "h-full w-full object-cover")}
          kind={
            <>
              <Disc3 className="h-3 w-3" aria-hidden />
              {t("import.match.album")}
            </>
          }
          title={found.album.title}
          meta={albumArtists(found)}
        >
          <p className="text-sm text-muted-foreground">{t("import.match.tracks", { n: found.album.tracks.length })}</p>
          {check ? (
            <ImportReviewNoMatch
              icon={<AlertCircle className="h-4 w-4" />}
              title={t("import.match.check")}
              hint={t("import.match.checkHint")}
              data-testid="import-match-check"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {check ? (
              <Button
                size="sm"
                onClick={() => {
                  console.info(`[import-review] match ${albumKey} confirmed by the user`);
                  setConfirmed((previous) => new Set(previous).add(albumKey));
                }}
                data-testid="import-match-confirm"
              >
                {t("import.match.looksRight")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.info(`[import-review] match ${albumKey} cleared: ${files.length} song(s) to Unidentified`);
                unplace(files.map((entry) => entry.file));
                select(UNIDENTIFIED);
              }}
              data-testid="import-match-clear"
            >
              {t("import.match.clear")}
            </Button>
          </div>
        </ImportReviewMatchHeader>
        <ImportReviewItems heading={t("import.match.tracksHeading")} data-testid="import-match-tracks">
          {found.album.tracks.map((track) => {
            const entry = byTrack.get(trackKey(track));
            const label = `${track.number} · ${entry ? named(entry).title : track.title}`;
            return entry ? (
              songItem(entry, label)
            ) : (
              <ImportReviewItem key={trackKey(track)} dimmed label={label} sub={t("import.match.notImported")} data-testid="import-match-track-missing" data-track={String(track.number)} />
            );
          })}
          {added.map((entry) => songItem(entry, `+ · ${named(entry).title}`, t("import.match.extra")))}
        </ImportReviewItems>
        {current ? songEdit(current) : <p className="text-sm text-muted-foreground">{t("import.review.pick")}</p>}
        <AlbumSearch
          key={albumKey}
          t={t}
          label={t("import.match.search")}
          artist={found.album.artist.name}
          album={found.album.title}
          onChoose={(picked) => chooseAlbum(albumKey, files, picked)}
        />
      </div>
    );
  };

  const unidentifiedDetail = () => {
    const current = unidentified.find((entry) => entry.file === song) ?? null;
    const allFailed = unidentified.every((entry) => reasons[entry.file] === "lookup-failed");
    return (
      <div className="space-y-6" data-testid="import-unidentified">
        <ImportReviewNoMatch
          icon={<AlertCircle className="h-4 w-4" />}
          title={t("import.unidentified.heading")}
          hint={allFailed ? t("import.unidentified.failedHint") : t("import.unidentified.hint")}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={undecided.length === 0}
          onClick={() => setFate(undecided.map((entry) => entry.file), "keep")}
          data-testid="import-unidentified-keep-all"
        >
          {t("import.unidentified.keepAll")}
        </Button>
        <ImportReviewItems heading={t("import.review.songsHeading")} data-testid="import-unidentified-songs">
          {unidentified.map((entry) => {
            const fate = fates[entry.file];
            const reason = reasons[entry.file];
            const why = fate === "keep" ? t("import.file.kept") : fate === "drop" ? t("import.file.dropped") : reason ? t(REASON_TEXT[reason]) : t("import.unidentified.moved");
            return (
              <ImportReviewItem
                key={entry.file}
                selected={song === entry.file}
                onSelect={() => setSong(entry.file)}
                dimmed={fate === "drop" || unticked.has(entry.file)}
                label={named(entry).title || fileName(entry.file)}
                sub={[named(entry).artist, named(entry).album, why].filter(Boolean).join(" · ")}
                data-testid="import-unidentified-file"
                data-file={entry.file}
                data-fate={fate ?? "undecided"}
                trailing={
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant={fate === "keep" ? "secondary" : "ghost"} aria-pressed={fate === "keep"} onClick={() => setFate([entry.file], "keep")} data-testid="import-file-keep">
                      {t("import.file.keep")}
                    </Button>
                    <Button size="sm" variant={fate === "drop" ? "secondary" : "ghost"} aria-pressed={fate === "drop"} onClick={() => setFate([entry.file], "drop")} data-testid="import-file-drop">
                      {t("import.file.drop")}
                    </Button>
                  </div>
                }
              />
            );
          })}
        </ImportReviewItems>
        {current ? (
          <div className="space-y-6" data-testid="import-unidentified-pick">
            <div className="max-w-md space-y-5" data-testid="import-review-song-edit">
              <div className="truncate text-xs text-muted-foreground" title={current.file}>
                {fileName(current.file)} · {formatLocalizedStorage(current.size, language)}
              </div>
              {nameFields(current)}
            </div>
            <SongSearch
              key={`identify-${current.file}`}
              t={t}
              start={named(current)}
              taken={(albumKey) => takenOn(albumKey)}
              onChoose={(found, track) => {
                console.info(`[import-review] song identified by the user: ${parrotAlbumKey(found.album)} track ${track.disc}-${track.number}`);
                // The picked song's names replace what was typed before (PAR-UP-05): the match is the user's last word.
                forgetTyped(current.file, NAME_FIELDS);
                place({ ...found, tracklistKnown: true }, [{ file: current.file, disc: track.disc, number: track.number }]);
                setSong(null);
              }}
            />
            <AddToAlbum
              key={`add-${current.file}`}
              t={t}
              entry={current}
              albums={groups.map((group) => group.found)}
              taken={(albumKey) => takenOn(albumKey)}
              onChoose={(found, track) => {
                console.info(`[import-review] song added to album by the user: ${parrotAlbumKey(found.album)} ${track ? `track ${track.disc}-${track.number}` : "(not on its tracklist)"}`);
                // The album names the artist and album; a track also names the song.
                forgetTyped(current.file, track ? NAME_FIELDS : ["artist", "album"]);
                place(found, [{ file: current.file, disc: track?.disc ?? 1, number: track?.number ?? null }]);
                setSong(null);
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("import.unidentified.pick")}</p>
        )}
      </div>
    );
  };

  const currentGroup = groups.find((group) => parrotAlbumKey(group.found.album) === selected) ?? null;
  const allTicked = ticked.length === scan.entries.length;

  /**
   * PAR-UP-06 (Chris 2026-11-12): who the album is by, in its header: each artist's small round photo (or the drawn
   * picture the library shows for it) and name, then the year; a Commons photo's credit under them (PAR-META-15).
   */
  const albumArtists = (found: FoundAlbum) => {
    const artists = parrotAlbumArtists(found.album);
    const credited = artists.flatMap((artist) => {
      const credit = artist.id ? photos[artist.id] : undefined;
      return credit?.photo && credit.credit ? [{ key: artist.id ?? artist.name, credit: credit.credit }] : [];
    });
    return (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="import-match-artists">
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
      </>
    );
  };

  return (
    <ImportReviewDialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel();
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
                  checked={allTicked}
                  aria-label={t("import.review.all")}
                  onCheckedChange={(on) => setTicked(scan.entries.map((entry) => entry.file), on)}
                  data-testid="import-review-all"
                />
                <span data-testid="import-review-all-label">{t("import.review.all")}</span>
              </div>
              {!matched ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground" data-testid="import-match-looking">
                  <Spinner size="sm" />
                  {t("import.match.looking")}
                </div>
              ) : null}
              {groups.map(({ found, files }) => {
                const albumKey = parrotAlbumKey(found.album);
                const check = files.some((entry) => !places[entry.file].sure) && !confirmed.has(albumKey);
                const onTracks = files.filter((entry) => places[entry.file].number !== null).length;
                const incomplete = found.tracklistKnown && onTracks < found.album.tracks.length;
                const paths = files.map((entry) => entry.file);
                return (
                  <ImportReviewRow
                    key={albumKey}
                    selected={selected === albumKey}
                    onSelect={() => select(albumKey)}
                    icon={albumArt(found, "h-10 w-10 shrink-0 rounded object-cover")}
                    title={found.album.title}
                    titleText={found.album.title}
                    data-testid="import-review-album"
                    data-match="found"
                    data-album={found.album.title}
                    trailing={
                      <Checkbox
                        checked={paths.every((file) => !unticked.has(file))}
                        aria-label={found.album.title}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={(next) => setTicked(paths, next)}
                        data-testid="import-review-album-check"
                      />
                    }
                  >
                    <div className="mt-1 truncate text-xs text-muted-foreground">{[artistNames(found), found.album.year].filter(Boolean).join(" · ")}</div>
                    {check || incomplete ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {check ? (
                          <ImportReviewBadge tone="attention" data-testid="import-album-check">
                            {t("import.match.check")}
                          </ImportReviewBadge>
                        ) : null}
                        {incomplete ? (
                          <ImportReviewBadge data-testid="import-album-incomplete">{t("import.match.incomplete", { have: onTracks, total: found.album.tracks.length })}</ImportReviewBadge>
                        ) : null}
                      </div>
                    ) : null}
                  </ImportReviewRow>
                );
              })}
              {unidentified.length > 0 ? (
                <ImportReviewRow
                  selected={selected === UNIDENTIFIED}
                  onSelect={() => select(UNIDENTIFIED)}
                  icon={
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-amber-500/10">
                      <AlertCircle className="h-5 w-5 text-amber-300" aria-hidden />
                    </div>
                  }
                  title={t("import.unidentified.heading")}
                  data-testid="import-group-unidentified"
                  data-count={unidentified.length}
                  data-undecided={undecided.length}
                >
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {t("import.unidentified.rowLine", { decided: unidentified.length - undecided.length, n: unidentified.length })}
                  </div>
                </ImportReviewRow>
              ) : null}
              {scan.unreadable.length > 0 ? (
                <ImportReviewSection tone="attention" data-testid="import-review-unreadable">
                  {t("import.review.unreadable", { n: scan.unreadable.length })}
                </ImportReviewSection>
              ) : null}
            </ImportReviewList>
            <ImportReviewDetail>
              {!matched ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner size="sm" />
                  {t("import.match.looking")}
                </div>
              ) : selected === UNIDENTIFIED && unidentified.length > 0 ? (
                unidentifiedDetail()
              ) : currentGroup ? (
                albumDetail(currentGroup.found, currentGroup.files)
              ) : null}
            </ImportReviewDetail>
          </>
        )}
      </ImportReviewBody>
      <ImportReviewFooter>
        <ImportReviewSummary data-testid="import-review-summary">
          {t("import.review.summary", { selected: importing.length, total: scan.entries.length, size: formatLocalizedStorage(importingBytes, language) })}
        </ImportReviewSummary>
        <ImportReviewActions>
          {blocked && scan.entries.length > 0 ? <ImportReviewBlocked data-testid="import-review-blocked">{blocked}</ImportReviewBlocked> : null}
          <Button variant="ghost" disabled={busy} onClick={() => void cancel()} data-testid="import-review-cancel">
            {t("import.review.cancel")}
          </Button>
          <Button disabled={busy || importing.length === 0 || Boolean(blocked)} onClick={() => void confirm()} data-testid="import-review-confirm">
            {t(`import.review.confirm.${new Intl.PluralRules(language).select(importing.length) === "one" ? "one" : "other"}`, { n: importing.length })}
          </Button>
        </ImportReviewActions>
      </ImportReviewFooter>
    </ImportReviewDialog>
  );
}

/**
 * An album search (PAR-UP-05): "Wrong album? Search" under an album, and "Add to album…" for a song. The user types
 * an artist and an album, our music library answers a few albums with their covers, and Select picks one.
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
              artwork={albumArt(found, "h-full w-full object-cover")}
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

type TakenTracks = (albumKey: string) => Array<{ disc: number; number: number }>;

/**
 * "Identify" for an unidentified song (PAR-UP-05): the user types its artist and title (the names typed for it, else
 * its tags, to start with), our music library answers the songs it knows, each on its album, and Select puts the song
 * on that album's track, whose names then replace any typed ones. A track another song of this import already holds
 * can't be picked.
 */
function SongSearch({
  t,
  start,
  taken,
  onChoose,
}: {
  t: Translate;
  /** The song's names as the import would store them (typed ones, else its tags): the search starts from them. */
  start: Pick<ParrotImportEdit, "artist" | "title" | "album">;
  taken: TakenTracks;
  onChoose: (found: ParrotImportFoundAlbum, track: MusicAlbumTrack) => void;
}) {
  const [open, setOpen] = useState(false);
  // Each field follows the song's names until the user types in it here.
  const [ownArtist, setArtist] = useState<string | null>(null);
  const [ownTitle, setTitle] = useState<string | null>(null);
  const artist = ownArtist ?? start.artist;
  const title = ownTitle ?? start.title;
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<ParrotImportSongSearch | null>(null);
  const withCover = useSearchCovers(answer);

  const search = async () => {
    if (searching || !artist.trim() || !title.trim()) return;
    setSearching(true);
    const found = await window.parrot.searchImportSongs({ artist, title, album: start.album }).catch((error: unknown) => {
      console.warn("[import-review] song search failed", error);
      return { kind: "failed" } as const;
    });
    console.info(`[import-review] song search: ${found.kind === "found" ? `${found.results.length} result(s)` : "failed"}`);
    setAnswer(found);
    setSearching(false);
  };

  return (
    <ImportReviewMatchSearch
      open={open}
      onOpenChange={setOpen}
      label={t("import.file.identify")}
      data-testid="import-file-identify"
      controls={
        <>
          <Input
            value={artist}
            onChange={(event) => setArtist(event.target.value)}
            placeholder={t("import.review.artist")}
            aria-label={t("import.review.artist")}
            className="flex-1"
            onKeyDown={(event) => event.key === "Enter" && void search()}
            data-testid="import-file-identify-artist"
          />
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("import.review.title")}
            aria-label={t("import.review.title")}
            className="flex-1"
            onKeyDown={(event) => event.key === "Enter" && void search()}
            data-testid="import-file-identify-title"
          />
          <Button variant="secondary" onClick={() => void search()} disabled={searching} data-testid="import-file-identify-submit">
            {searching ? <Spinner size="sm" /> : t("import.match.searchGo")}
          </Button>
        </>
      }
    >
      {searching ? (
        <ImportReviewSearching className="mt-4" icon={<Spinner size="sm" />} title={t("manage.searching")} data-testid="import-file-identify-searching" />
      ) : answer?.kind === "failed" ? (
        <p className="mt-4 text-sm text-amber-300" data-testid="import-file-identify-failed">
          {t("import.match.searchFailed")}
        </p>
      ) : answer?.results.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="import-file-identify-none">
          {t("import.file.identifyNone")}
        </p>
      ) : answer ? (
        <div className="mt-4 grid grid-cols-2 gap-4 pb-2 md:grid-cols-4">
          {answer.results.map(withCover).map((found) => {
            const busy = taken(parrotAlbumKey(found.album)).some((track) => trackKey(track) === trackKey(found.track));
            return (
              <ImportReviewMatchResult
                key={`${parrotAlbumKey(found.album)}-${trackKey(found.track)}`}
                artworkShape="square"
                artwork={albumArt(found, "h-full w-full object-cover")}
                title={found.track.title}
                meta={t("import.file.onAlbum", { album: found.album.title, number: found.track.number, artist: found.album.artist.name })}
                selectLabel={busy ? t("import.file.trackTaken") : t("import.match.select")}
                onSelect={() => {
                  if (busy) return;
                  onChoose(found, found.track);
                  setOpen(false);
                }}
                data-testid="import-file-identify-result"
                data-taken={busy || undefined}
              />
            );
          })}
        </div>
      ) : null}
    </ImportReviewMatchSearch>
  );
}

/**
 * "Add to album…" for an unidentified song (PAR-UP-05, Chris 2026-11-11): the user picks one of this import's albums
 * (or searches another), then the track it is, or "Not on its tracklist" to add it to the album as is. Never done
 * without the user.
 */
function AddToAlbum({
  t,
  entry,
  albums,
  taken,
  onChoose,
}: {
  t: Translate;
  entry: ParrotScanEntry;
  albums: FoundAlbum[];
  taken: TakenTracks;
  onChoose: (found: FoundAlbum, track: MusicAlbumTrack | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FoundAlbum | null>(null);
  const busy = new Set(picked ? taken(parrotAlbumKey(picked.album)).map(trackKey) : []);

  return (
    <ImportReviewMatchSearch
      open={open}
      onOpenChange={setOpen}
      label={t("import.file.addToAlbum")}
      data-testid="import-file-add-to-album"
      controls={
        picked ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {albumArt(picked, "h-10 w-10 shrink-0 rounded object-cover")}
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{picked.album.title}</div>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)} data-testid="import-file-add-back">
              {t("import.file.otherAlbum")}
            </Button>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("import.file.pickAlbum")}</div>
        )
      }
    >
      {picked ? (
        <div className="mt-4 space-y-3">
          <div className="text-sm font-semibold">{t("import.file.pickTrack")}</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {picked.album.tracks.map((track) => {
              const held = busy.has(trackKey(track));
              return (
                <Button
                  key={trackKey(track)}
                  variant="outline"
                  size="sm"
                  className="justify-start truncate"
                  disabled={held}
                  onClick={() => onChoose(picked, track)}
                  data-testid="import-file-add-track"
                  data-track={String(track.number)}
                >
                  {track.number} · {track.title}
                  {held ? ` · ${t("import.file.trackTaken")}` : ""}
                </Button>
              );
            })}
          </div>
          <Button variant="secondary" size="sm" onClick={() => onChoose(picked, null)} data-testid="import-file-add-extra">
            {t("import.file.addExtra")}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {albums.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {albums.map((found) => (
                <Button
                  key={parrotAlbumKey(found.album)}
                  variant="outline"
                  className="h-auto justify-start gap-3 py-2"
                  onClick={() => setPicked(found)}
                  data-testid="import-file-add-album"
                  data-album={found.album.title}
                >
                  {albumArt(found, "h-8 w-8 shrink-0 rounded object-cover")}
                  <span className="truncate">{found.album.title}</span>
                </Button>
              ))}
            </div>
          ) : null}
          <AlbumSearch t={t} label={t("import.file.searchAlbum")} artist={entry.artist} album={entry.album} onChoose={(found) => setPicked({ ...found, tracklistKnown: true })} />
        </div>
      )}
    </ImportReviewMatchSearch>
  );
}
