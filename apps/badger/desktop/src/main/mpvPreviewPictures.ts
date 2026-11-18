/**
 * Seek-bar preview pictures for the external mpv (MPV-PREV-01, desktop).
 *
 * The renderer hands over the playing video's preview record (`MediaFormat.previewSheets` of the source format). While
 * the seekbar is hovered, tog4in1.lua sends `sf-preview-hover <token> <seconds>` once per picture slot; this service
 * locates the picture (`locatePreviewPicture`), fetches the sheet through the local playback server (which decrypts it,
 * like subtitle objects), decodes the JPEG ONCE per sheet to raw BGRA (Electron's in-process image decoder) and slices
 * the picture out in memory, writes it to a file in a private per-session temp dir, and answers `sf-preview-picture` so
 * the OSC draws it with `overlay-add` (which reads raw BGRA from a file only).
 *
 * Decode once per sheet, slice in memory: scrubbing across a sheet asks for up to 100 pictures, and one decode serves
 * them all, where a slice is a 64 KB copy.
 *
 * Memory only: each sheet's decrypted JPEG is fetched at most once per playback and kept (about 150 KB each); at most
 * `DECODED_SHEETS_KEPT` decoded sheets (about 6 MB each for 16:9) are kept. On disk there are at most 2 pictures: the
 * one the OSC said it shows (`sf-preview-shown <token>`; it re-runs overlay-add from that file when the pointer moves)
 * and the newest one sent. They are removed on reset, the whole dir is removed when the app exits, and a dir left by a
 * crashed app is swept at the next start (`sweepStalePreviewDirs`).
 *
 * Lag: requests are debounced (`PREVIEW_HOVER_DEBOUNCE_MS`) and every step checks the request is still the latest
 * one; a stale result is dropped (its sheet stays cached). The OSC also ignores a reply whose token it did not just
 * send. When the latest request cannot be shown (no picture at that moment, the sheet failed to fetch or decode, or is
 * smaller than its record), the answer is `path: null` so the OSC removes the previous picture instead of keeping a
 * wrong moment on screen. A video without previews (null or malformed record) never gets a request: the OSC draws
 * nothing, or, when the renderer names its source format and a hint text and the runtime's catch-up pass has not given
 * up on it (`previewStatus`, MPV-PREV-06), the OSC writes the hint ("Previews are being prepared") above the time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locatePreviewPicture,
  parsePreviewSheets,
  type MediaPreviewSheet,
  type MediaPreviewSheets,
} from "@space/shared/previewSheets";
import type { PreviewPicturePayload, PreviewSheetsPayload } from "@space/mpv-protocol";

export const PREVIEW_HOVER_DEBOUNCE_MS = 30;
export const DECODED_SHEETS_KEPT = 2;
/** Preview dirs are `sf-mpv-previews-<pid>-<random>`: the pid tells the start-up sweep whose dir it is. */
const PREVIEW_DIR_PREFIX = "sf-mpv-previews-";
const PREVIEW_DIR_NAME = /^sf-mpv-previews-(\d+)-/;
/** A hover this many pictures (50 s) from its sheet's edge prefetches the neighbouring sheet. */
export const PREFETCH_EDGE_PICTURES = 10;

type Logger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};

export type MpvPreviewPicturesDeps = {
  /** The decrypted JPEG bytes of a sheet object. */
  fetchSheet: (objectKey: string) => Promise<Buffer>;
  /** Raw BGRA pixels of a JPEG, `width` pixels wide (rows follow from the length). */
  decodeSheet: (jpeg: Buffer, width: number) => Promise<Buffer>;
  sendSheets: (payload: PreviewSheetsPayload) => void;
  /**
   * MPV-PREV-06: whether a video with no record will still get previews (the runtime's `badger.previews.get_status`).
   * Null when the runtime cannot be asked. Without it every missing record reads as still to come.
   */
  previewStatus?: (formatId: string) => Promise<PreviewStatusAnswer | null>;
  sendPicture: (payload: PreviewPicturePayload) => void;
  /** Parent of the private per-session dir (default: the OS temp dir). */
  tempRoot?: string;
  debounceMs?: number;
  log?: Logger;
};

const silent: Logger = { info: () => {}, warn: () => {}, debug: () => {} };

export type PreviewStatusAnswer = { state: "pending" | "failed"; failures: number; maxAttempts: number };

/** What the renderer knows about a video with no record: its source format and the hint text in the UI language. */
export type MissingPreviews = { formatId: string | null; hint: string };

/** Copy one picture's rows out of a decoded sheet. Null when the sheet is smaller than the record says. */
export const slicePicture = (
  sheetPixels: Buffer,
  sheetWidth: number,
  rect: { x: number; y: number; width: number; height: number },
): Buffer | null => {
  const sheetStride = sheetWidth * 4;
  const rowBytes = rect.width * 4;
  if (sheetPixels.length % sheetStride !== 0) return null;
  if (rect.x + rect.width > sheetWidth || (rect.y + rect.height) * sheetStride > sheetPixels.length) return null;
  const out = Buffer.allocUnsafe(rowBytes * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const from = (rect.y + row) * sheetStride + rect.x * 4;
    sheetPixels.copy(out, row * rowBytes, from, from + rowBytes);
  }
  return out;
};

export type MpvPreviewPictures = {
  /**
   * The playing video's record (raw JSON column or parsed); anything malformed means no previews. `missing` names
   * the source format and the hint text for when there is no record (MPV-PREV-06).
   */
  setPreviews: (raw: unknown, missing?: MissingPreviews) => void;
  /** OSC hover request; `seconds < 0` means the pointer left the seekbar. */
  hover: (token: number, seconds: number) => void;
  /** Playback ended: forget the record, the cached sheets and the picture files. */
  reset: () => void;
  /** The OSC accepted the picture answered for `token` and draws it (`sf-preview-shown`). */
  shown: (token: number) => void;
  /** App exit: remove the private dir (sync, safe in process "exit"). */
  disposeSync: () => void;
  /** The private per-session dir, if one was made. */
  getDir: () => string | null;
};

export const createMpvPreviewPictures = (deps: MpvPreviewPicturesDeps): MpvPreviewPictures => {
  const log = deps.log ?? silent;
  const debounceMs = deps.debounceMs ?? PREVIEW_HOVER_DEBOUNCE_MS;
  let previews: MediaPreviewSheets | null = null;
  // Bumped by every setPreviews / reset: work begun for another record is stale.
  let generation = 0;
  let latestToken: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const jpegs = new Map<string, Promise<Buffer>>();
  const decoded = new Map<string, Promise<Buffer>>();
  let dir: string | null = null;
  // Picture files on disk: the newest one sent, and the one the OSC confirmed it shows.
  let written: Array<{ token: number; path: string }> = [];
  let shownPath: string | null = null;
  let fileSeq = 0;

  // MPV-PREV-06: the runtime's answer per source format, asked once per playback; `missingSeq` drops a late answer.
  const statuses = new Map<string, Promise<PreviewStatusAnswer | null>>();
  let missingSeq = 0;

  const askStatus = (formatId: string): Promise<PreviewStatusAnswer | null> => {
    let pending = statuses.get(formatId);
    if (!pending) {
      pending = deps.previewStatus
        ? deps.previewStatus(formatId).catch((error: unknown) => {
            log.warn({ formatId, error: error instanceof Error ? error.message : String(error) }, "preview status failed");
            return null;
          })
        : Promise.resolve(null);
      statuses.set(formatId, pending);
    }
    return pending;
  };

  /** No record: the hint while previews are still to come, nothing once generation gave up on the video. */
  const sendMissing = (missing: MissingPreviews | undefined) => {
    const seq = ++missingSeq;
    const formatId = missing?.formatId ?? null;
    const hint = missing?.hint.trim() ?? "";
    if (!formatId || !hint) {
      deps.sendSheets(null);
      return;
    }
    void askStatus(formatId).then((status) => {
      if (seq !== missingSeq) return;
      const showHint = status?.state !== "failed";
      // The line that tells a "no previews" report apart: still being made (hint shown) or given up (nothing shown).
      log.info(
        { formatId, state: status?.state ?? "unknown", failures: status?.failures ?? null, maxAttempts: status?.maxAttempts ?? null, hint: showHint },
        showHint ? "preview sheets missing: hint shown (being prepared)" : "preview sheets missing: generation gave up, no hint",
      );
      deps.sendSheets(showHint ? { hint } : null);
    });
  };

  const sheetWidth = (record: MediaPreviewSheets) => record.columns * record.pictureWidth;

  const fetchOnce = (sheet: MediaPreviewSheet): Promise<Buffer> => {
    let pending = jpegs.get(sheet.objectKey);
    if (!pending) {
      log.debug({ objectKey: sheet.objectKey }, "preview sheet fetch");
      pending = deps.fetchSheet(sheet.objectKey);
      // A failed fetch stays failed for this playback (at most one fetch per sheet); the hover shows nothing.
      pending.catch((error: unknown) => {
        log.warn({ objectKey: sheet.objectKey, error: error instanceof Error ? error.message : String(error) }, "preview sheet fetch failed");
      });
      jpegs.set(sheet.objectKey, pending);
    }
    return pending;
  };

  const decodedSheet = (record: MediaPreviewSheets, sheet: MediaPreviewSheet): Promise<Buffer> => {
    const hit = decoded.get(sheet.objectKey);
    if (hit) {
      decoded.delete(sheet.objectKey);
      decoded.set(sheet.objectKey, hit);
      return hit;
    }
    const pending = fetchOnce(sheet).then((jpeg) => deps.decodeSheet(jpeg, sheetWidth(record)));
    // A failed decode is not kept: the next hover on this sheet decodes the cached JPEG again.
    pending.catch(() => {
      if (decoded.get(sheet.objectKey) === pending) decoded.delete(sheet.objectKey);
    });
    decoded.set(sheet.objectKey, pending);
    while (decoded.size > DECODED_SHEETS_KEPT) {
      const oldest = decoded.keys().next().value as string;
      decoded.delete(oldest);
    }
    return pending;
  };

  const prefetchNeighbour = (record: MediaPreviewSheets, sheetIndex: number, pictureIndex: number) => {
    const sheet = record.sheets[sheetIndex]!;
    const within = pictureIndex - sheet.firstPicture;
    const next = record.sheets[sheetIndex + 1];
    const previous = record.sheets[sheetIndex - 1];
    if (next && sheet.pictureCount - 1 - within < PREFETCH_EDGE_PICTURES) void fetchOnce(next).catch(() => {});
    if (previous && within < PREFETCH_EDGE_PICTURES) void fetchOnce(previous).catch(() => {});
  };

  const ensureDir = (): string => {
    if (!dir) dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), `${PREVIEW_DIR_PREFIX}${process.pid}-`));
    return dir;
  };

  const removeFiles = (paths: string[]) =>
    Promise.all(paths.map((path) => fs.rm(path, { force: true }).catch(() => {})));

  /** Delete every picture file except the newest one sent and the one the OSC shows. */
  const pruneFiles = () => {
    const newest = written.at(-1)?.path;
    const gone = written.filter((file) => file.path !== newest && file.path !== shownPath);
    if (gone.length === 0) return Promise.resolve();
    written = written.filter((file) => !gone.includes(file));
    return removeFiles(gone.map((file) => file.path));
  };

  const isCurrent = (token: number, gen: number) => latestToken === token && generation === gen;

  /** The latest request has no picture to show: tell the OSC so it removes the previous (wrong) one. */
  const answerNone = (token: number, gen: number) => {
    if (isCurrent(token, gen)) deps.sendPicture({ token, path: null });
  };

  const run = async (token: number, seconds: number, gen: number) => {
    const record = previews;
    if (!record || !isCurrent(token, gen)) return;
    const location = locatePreviewPicture(record, seconds);
    if (!location) return answerNone(token, gen);
    // The picture asked for comes first; the neighbouring sheet is fetched behind it.
    const sheetPixels = decodedSheet(record, location.sheet);
    prefetchNeighbour(record, location.sheetIndex, location.pictureIndex);
    let pixels: Buffer;
    try {
      pixels = await sheetPixels;
    } catch (error) {
      // A failed fetch is logged where it is cached; this also catches a failed decode.
      log.warn({ objectKey: location.sheet.objectKey, error: error instanceof Error ? error.message : String(error) }, "preview sheet unusable");
      return answerNone(token, gen);
    }
    if (!isCurrent(token, gen)) {
      log.debug({ token, latestToken }, "preview picture dropped (stale)");
      return;
    }
    const picture = slicePicture(pixels, sheetWidth(record), location);
    if (!picture) {
      log.warn({ objectKey: location.sheet.objectKey, bytes: pixels.length, sheetWidth: sheetWidth(record) }, "preview sheet smaller than its record");
      return answerNone(token, gen);
    }
    const path = join(ensureDir(), `${++fileSeq}.bgra`);
    await fs.writeFile(path, picture, { mode: 0o600 });
    if (!isCurrent(token, gen)) {
      await removeFiles([path]);
      return;
    }
    written.push({ token, path });
    await pruneFiles();
    deps.sendPicture({ token, path, width: location.width, height: location.height });
  };

  const cancel = () => {
    clearTimeout(timer ?? undefined);
    timer = null;
  };

  return {
    setPreviews(raw: unknown, missing?: MissingPreviews) {
      const parsed = parsePreviewSheets(raw);
      // Pixel sizes must be whole numbers to cut raw BGRA rows; anything else reads as no previews too.
      const next =
        parsed && [parsed.pictureWidth, parsed.pictureHeight, parsed.columns].every(Number.isInteger) ? parsed : null;
      // Metadata is re-sent on reloads and marker changes: the same record keeps its cached sheets (fetched at most
      // once per playback) and only re-tells the OSC.
      if (JSON.stringify(next) !== JSON.stringify(previews)) {
        cancel();
        generation += 1;
        latestToken = null;
        jpegs.clear();
        decoded.clear();
        previews = next;
        log.info({ hasPreviews: previews !== null, sheets: previews?.sheets.length ?? 0 }, "preview sheets set");
      }
      if (!previews) {
        sendMissing(missing);
        return;
      }
      missingSeq += 1;
      deps.sendSheets({ width: previews.pictureWidth, height: previews.pictureHeight, intervalSeconds: previews.intervalSeconds });
    },
    hover(token: number, seconds: number) {
      cancel();
      if (!previews || !Number.isFinite(token) || !Number.isFinite(seconds) || seconds < 0) {
        latestToken = null;
        return;
      }
      latestToken = token;
      const gen = generation;
      timer = setTimeout(() => {
        timer = null;
        void run(token, seconds, gen).catch((error: unknown) => {
          log.warn({ error: error instanceof Error ? error.message : String(error) }, "preview picture failed");
        });
      }, debounceMs);
    },
    shown(token: number) {
      const file = written.find((entry) => entry.token === token);
      if (!file) return;
      shownPath = file.path;
      void pruneFiles();
    },
    reset() {
      cancel();
      generation += 1;
      latestToken = null;
      previews = null;
      statuses.clear();
      missingSeq += 1;
      jpegs.clear();
      decoded.clear();
      shownPath = null;
      void removeFiles(written.splice(0).map((file) => file.path));
    },
    disposeSync() {
      cancel();
      generation += 1;
      previews = null;
      jpegs.clear();
      decoded.clear();
      written = [];
      shownPath = null;
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    },
    getDir: () => dir,
  };
};

export type PreviewDirSweepInput = {
  tmp: string;
  /** Whether the app process that made a preview dir still runs (this one, or another instance). */
  isAlive: (pid: number) => boolean;
  log: Pick<Logger, "info" | "warn">;
  remove?: (path: string) => Promise<void>;
};

/**
 * App start: delete the preview dirs (decrypted pictures) whose app process is gone. Quitting removes the dir; a crash,
 * a kill or a power loss skips that, and Windows and macOS never clear the temp dir. Never throws.
 */
export const sweepStalePreviewDirs = async (input: PreviewDirSweepInput): Promise<void> => {
  const remove = input.remove ?? ((path: string) => fs.rm(path, { recursive: true, force: true }));
  let names: string[];
  try {
    names = await fs.readdir(input.tmp);
  } catch (error) {
    input.log.warn({ tmp: input.tmp, error: error instanceof Error ? error.message : String(error) }, "stale preview dirs not swept");
    return;
  }
  let removed = 0;
  for (const name of names) {
    const pid = PREVIEW_DIR_NAME.exec(name)?.[1];
    if (pid === undefined || input.isAlive(Number(pid))) continue;
    const path = join(input.tmp, name);
    try {
      await remove(path);
      removed += 1;
    } catch (error) {
      input.log.warn({ dir: path, error: error instanceof Error ? error.message : String(error) }, "stale preview dir not removed");
    }
  }
  if (removed > 0) input.log.info({ removed }, "stale preview dirs swept");
};

/** The part of Electron's `NativeImage` the decoder uses. */
export type DecodableImage = { isEmpty(): boolean; getSize(): { width: number; height: number }; toBitmap(): Buffer };

/**
 * Decode a JPEG sheet to raw BGRA in process with Electron's image decoder (`nativeImage.createFromBuffer`; its
 * bitmap is Skia's N32 order, BGRA on every little-endian desktop). Not ffmpeg: the bundled ffmpeg is built without
 * the rawvideo encoder, so it cannot write raw pixels.
 */
export const decodeSheetWithNativeImage =
  (createFromBuffer: (jpeg: Buffer) => DecodableImage) => async (jpeg: Buffer, width: number): Promise<Buffer> => {
    const image = createFromBuffer(jpeg);
    const size = image.getSize();
    if (image.isEmpty() || size.width !== width) throw new Error(`decoded sheet is ${size.width}x${size.height}, not ${width} px wide`);
    const pixels = image.toBitmap();
    if (pixels.length !== size.width * size.height * 4) throw new Error(`decoded sheet is ${pixels.length} bytes, not ${size.width}x${size.height} BGRA`);
    return pixels;
  };

/** Fetch a sheet through the local playback server, which decrypts it (same route as subtitle objects). */
export const fetchSheetFromPlaybackServer = (getBaseUrl: () => string | null) => async (objectKey: string): Promise<Buffer> => {
  const base = getBaseUrl();
  if (!base) throw new Error("playback_server_unavailable");
  const response = await fetch(`${base}/playback/object/${encodeURIComponent(objectKey)}`);
  if (!response.ok) throw new Error(`preview sheet HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
