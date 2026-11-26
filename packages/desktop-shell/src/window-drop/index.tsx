import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Upload } from "lucide-react";

/**
 * Files or folders dropped anywhere on a desktop app's window (UX-ADD-01): Badger and Parrot share this one drop
 * handling and overlay, each app only says what a drop opens and what the overlay reads.
 */

type FileWithOptionalPath = File & { path?: string };

/** Electron's `webUtils.getPathForFile`, exposed by each app's preload. */
export type GetPathForFile = (file: File) => string | null | undefined;

/**
 * Images are never imported by a window drop (UX-ADD-02, Chris 2026-11-11: "Ignoring images altogether could be a good
 * option"): a cast photo or a website image dragged onto the window does nothing, and images dropped with media are
 * left out silently.
 */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".svg", ".ico", ".jxl"]);

/** The lowercased extension of a file name or path (`""` for none or a dot name like `.hidden`). */
export const extensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

const isImage = (name: string, mime = ""): boolean => mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(name));

/**
 * A drag from outside the app that carries at least one real file or folder that is not an image. During a drag only
 * each item's kind and MIME type can be read (a folder or an unknown file reads as `""`), so an image-only drag (a
 * website image, a picture from the file manager) is told apart here and never shows the overlay.
 */
export const isExternalFileDrag = (dt: DataTransfer | null | undefined): boolean => {
  if (!dt || !Array.from(dt.types ?? []).includes("Files")) return false;
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === "file");
  // Some platforms list no items while dragging: "Files" alone still means real files.
  if (items.length === 0) return !dt.items || dt.items.length === 0;
  return items.some((item) => !item.type.startsWith("image/"));
};

/**
 * The path a `file://` URI names. A drive letter makes it a Windows path (`file:///C:/a%20b` → `C:\a b`), a host other
 * than `localhost` a network one (`file://nas/share` → `\\nas\share`); anything else stays a POSIX path.
 */
export const fileUriPath = (uri: string): string => {
  const rest = uri.slice("file://".length);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = decodeURIComponent(slash < 0 ? "/" : rest.slice(slash));
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) return path.slice(1).replaceAll("/", "\\");
  if (host && host.toLowerCase() !== "localhost") return `\\\\${decodeURIComponent(host)}${path.replaceAll("/", "\\")}`;
  return path;
};

/** What a drop holds, sorted: what the app imports, the images left out silently, and the other files it refuses. */
export type SortedDrop = { importable: string[]; images: string[]; refused: string[] };

/**
 * Sorts a drop's files and folders. A folder is always importable (the import reads what is inside it); a file is when
 * `isImportableFile` says so; an image never is. A file the app cannot reach on disk (an image dragged from a website
 * has no path) cannot be imported either. Without file entries, `file://` URIs are read (a folder is a name with no
 * extension there).
 */
export const sortDrop = (
  dt: DataTransfer | null | undefined,
  isImportableFile: (path: string) => boolean,
  getPathForFile?: GetPathForFile
): SortedDrop => {
  const sorted: SortedDrop = { importable: [], images: [], refused: [] };
  if (!dt) return sorted;
  const seen = new Set<string>();
  /** Non-image files with no path on disk: refused unless the drop's `file://` URIs say where they are. */
  const pathless: string[] = [];
  const add = (name: string, path: string | null | undefined, mime: string, isDirectory: boolean) => {
    const key = path || name;
    if (seen.has(key)) return;
    seen.add(key);
    if (isImage(name, mime)) sorted.images.push(key);
    else if (!path) pathless.push(name);
    else if (isDirectory || isImportableFile(path)) sorted.importable.push(path);
    else sorted.refused.push(path);
  };
  const pathOf = (file: File) => getPathForFile?.(file) || (file as FileWithOptionalPath).path;
  // A folder reads as a file with no MIME type; its entry says so where the platform gives one.
  const addFile = (file: File, entry?: { isDirectory: boolean } | null) =>
    add(file.name, pathOf(file), file.type, entry ? entry.isDirectory : !file.type && !extensionOf(file.name));

  const items = Array.from(dt.items ?? []).filter((item) => item.kind === "file");
  for (const item of items) {
    const file = item.getAsFile();
    if (file) addFile(file, item.webkitGetAsEntry?.());
  }
  if (items.length === 0 && dt.files) {
    for (let i = 0; i < dt.files.length; i++) addFile(dt.files[i]!);
  }
  const reached = sorted.importable.length + sorted.refused.length;
  if (reached === 0) {
    const uriPayload = dt.getData("text/uri-list") || dt.getData("text/plain");
    for (const line of (uriPayload ?? "").split(/\r?\n/).map((l) => l.trim())) {
      if (!line.startsWith("file://")) continue;
      try {
        const path = fileUriPath(line);
        add(path, path, "", !extensionOf(path));
      } catch {
        // Ignore malformed URI values.
      }
    }
  }
  if (sorted.importable.length + sorted.refused.length === reached) sorted.refused.push(...pathless);
  return sorted;
};

export type WindowFileDropOptions = {
  /** The importable paths of a drop, never empty: a drop with nothing to import does not reach the app. */
  onDrop: (paths: string[]) => void;
  /** A dropped file (not a folder, not an image) the app imports: Badger's videos and subtitles, Parrot's songs. */
  isImportableFile: (path: string) => boolean;
  /** Files the app cannot import were dropped (a PDF), with or without importable ones: the app says so in a toast. */
  onRefused?: (names: string[]) => void;
  getPathForFile?: GetPathForFile;
  /**
   * When it returns true the window drop also stands aside (see {@link windowDropStandsAside}), e.g. while the drop's
   * own import is running.
   */
  standAside?: () => boolean;
  /** The overlay never stays stuck if whatever the drop opens never says it is ready. */
  processingTimeoutMs?: number;
};

export type WindowFileDrop = {
  /** A file drag is over the window. */
  dragging: boolean;
  /** A drop was taken and what it opens is not shown yet. */
  processing: boolean;
  /** Takes a drop's payload (the overlay's own drop). */
  dropPayload: (dt: DataTransfer | null) => void;
  /** Shows the processing overlay for a drop that arrived another way (a native drop). */
  startProcessing: () => void;
  /** What the drop opened is on screen: the overlay goes. */
  stopProcessing: () => void;
};

/**
 * Spread on an element that takes file drops itself (Badger's poster and backdrop fields in edit mode): while it is on
 * screen, the window drop stands aside.
 */
export const OWN_FILE_DROP = { "data-window-drop": "own" } as const;

/**
 * Spread on a dialog that asks for a drop on the window (the first-open tour's step 1, UX-TOUR-01): it does not take
 * drops itself, so the window drop does not stand aside for it.
 */
export const WINDOW_DROP_PASSES = { "data-window-drop": "pass" } as const;

/** An open dialog (Parrot's edit dialog with its cover drop, Badger's import dialog) or an own drop takes drops itself. */
const TAKES_ITS_OWN_DROPS = '[role="dialog"]:not([data-window-drop="pass"]), [role="alertdialog"], [data-window-drop="own"]';

/**
 * While one of those is on screen, or the app asks it to, the window drop stands aside: no overlay, and the drop
 * reaches the element under the pointer. The browser's default (opening the file) is still prevented.
 * Returns why it stands aside (for the diagnostic warning), or null when it takes the drag.
 */
const windowDropStandsAside = (standAside?: () => boolean): string | null => {
  const own = document.querySelector(TAKES_ITS_OWN_DROPS);
  if (own) {
    const role = own.getAttribute("role");
    const testId = own.getAttribute("data-testid");
    const mark = own.getAttribute("data-window-drop");
    const attrs = [role && `role="${role}"`, testId && `data-testid="${testId}"`, mark && `data-window-drop="${mark}"`];
    return `stands aside for <${[own.tagName.toLowerCase(), ...attrs.filter(Boolean)].join(" ")}> on screen`;
  }
  return standAside?.() ? "stands aside: the app asked it to stand aside" : null;
};

/** Listens for file drags on the whole document, in the capture phase so no page element swallows them. */
export function useWindowFileDrop({
  onDrop,
  isImportableFile,
  onRefused,
  getPathForFile,
  standAside,
  processingTimeoutMs = 10_000,
}: WindowFileDropOptions): WindowFileDrop {
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const dragCounter = useRef(0);
  const latest = useRef({ onDrop, isImportableFile, onRefused, getPathForFile, standAside, processingTimeoutMs });
  latest.current = { onDrop, isImportableFile, onRefused, getPathForFile, standAside, processingTimeoutMs };

  const startProcessing = useCallback(() => {
    setDragging(false);
    dragCounter.current = 0;
    setProcessing(true);
    window.setTimeout(() => setProcessing(false), latest.current.processingTimeoutMs);
  }, []);
  const stopProcessing = useCallback(() => setProcessing(false), []);

  const dropPayload = useCallback(
    (dt: DataTransfer | null) => {
      const { importable, images, refused } = sortDrop(dt, latest.current.isImportableFile, latest.current.getPathForFile);
      // A warning, not info: the desktop apps forward only renderer warnings and errors to the main log (UX-ADD-01).
      console.warn(`[window-drop] ${importable.length} importable, ${images.length} image(s) left out, ${refused.length} refused`);
      if (refused.length > 0) latest.current.onRefused?.(refused.map((key) => key.split(/[\\/]/).pop() ?? key));
      if (importable.length === 0) {
        dragCounter.current = 0;
        setDragging(false);
        return;
      }
      startProcessing();
      latest.current.onDrop(importable);
    },
    [startProcessing]
  );

  useEffect(() => {
    // Says once per drag and per reason why a file drag from outside is not taken: the renderer's warnings reach the
    // main log, the only trace Chris's Wayland session leaves of a drop that "doesn't work" (UX-ADD-01, MPV-GPU-04).
    let warned: string | null = null;
    const warnOnce = (reason: string) => {
      if (reason === warned) return;
      warned = reason;
      console.warn(`[window-drop] file drag not taken: ${reason}`);
    };

    const asideFor = (e: DragEvent) => {
      const reason = windowDropStandsAside(latest.current.standAside);
      if (!reason) return false;
      if (isExternalFileDrag(e.dataTransfer)) warnOnce(reason);
      // Keep the window from opening the file, but let the element under the pointer take the drop.
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      return true;
    };

    // A drag that starts inside the window (a poster, a cast photo, a link) never becomes a drop: in-app images and
    // links are not draggable at all, and anything else dragged inside the window is not a file for the window drop.
    let internalDrag = false;
    const handleDragStart = (e: DragEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const source = target?.closest("img, a");
      if (source && source.getAttribute("draggable") !== "true") {
        e.preventDefault();
        return;
      }
      internalDrag = true;
    };
    const handleDragEnd = () => {
      internalDrag = false;
      warned = null;
    };
    // No mouse event fires while a drag is under way, so a move means the last drag is over even if its dragend never
    // came (dropped outside the window, cancelled by the compositor): a later drag from the file manager is taken
    // again instead of being refused as the window's own (UX-ADD-01).
    const handleMouseMove = () => {
      internalDrag = false;
      warned = null;
    };
    const takes = (e: DragEvent) => {
      if (!isExternalFileDrag(e.dataTransfer)) return false;
      if (internalDrag) {
        warnOnce("the drag started inside the window");
        return false;
      }
      return true;
    };
    /** A drag the window does not take: the window still never opens it, and the pointer says nothing drops here. */
    const refuse = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };

    const handleDragEnter = (e: DragEvent) => {
      if (asideFor(e)) return;
      if (!takes(e)) return refuse(e);
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current += 1;
      setDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (asideFor(e)) return;
      if (!takes(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current -= 1;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setDragging(false);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      if (asideFor(e)) return;
      if (!takes(e)) return refuse(e);
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const handleDrop = (e: DragEvent) => {
      if (asideFor(e)) return;
      const external = takes(e);
      internalDrag = false;
      warned = null;
      e.preventDefault();
      if (!external) return;
      e.stopPropagation();
      dropPayload(e.dataTransfer);
    };

    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("dragstart", handleDragStart, true);
    document.addEventListener("dragend", handleDragEnd, true);
    document.addEventListener("dragenter", handleDragEnter, true);
    document.addEventListener("dragleave", handleDragLeave, true);
    document.addEventListener("dragover", handleDragOver, true);
    document.addEventListener("drop", handleDrop, true);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("dragstart", handleDragStart, true);
      document.removeEventListener("dragend", handleDragEnd, true);
      document.removeEventListener("dragenter", handleDragEnter, true);
      document.removeEventListener("dragleave", handleDragLeave, true);
      document.removeEventListener("dragover", handleDragOver, true);
      document.removeEventListener("drop", handleDrop, true);
    };
  }, [dropPayload]);

  return { dragging, processing, dropPayload, startProcessing, stopProcessing };
}

export type WindowDropOverlayLabels = {
  dropTitle: ReactNode;
  dropSubtitle: ReactNode;
  processingTitle: ReactNode;
  processingSubtitle: ReactNode;
};

/** The full-window "drop here" card, in the app's accent colour (`primary`). */
export function WindowDropOverlay({ drop, labels }: { drop: WindowFileDrop; labels: WindowDropOverlayLabels }) {
  const { dragging, processing, dropPayload } = drop;
  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center bg-background/95 transition-all duration-200 ${
        dragging || processing ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      data-testid="window-drop-overlay"
      data-state={processing ? "processing" : dragging ? "dragging" : "hidden"}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dropPayload(e.dataTransfer);
      }}
    >
      <div className="rounded-3xl border-2 border-dashed border-primary bg-card/50 p-12 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/20">
          {processing ? (
            <Loader2 className="h-10 w-10 text-primary animate-spin" />
          ) : (
            // Bounces only while a drag shows the overlay: an infinite animation under opacity-0 still
            // costs a style recalc per frame for the whole session (#928, ~9 recalcs/s at idle).
            <Upload className={`h-10 w-10 text-primary ${dragging ? "animate-bounce" : ""}`} />
          )}
        </div>
        <div className="text-2xl font-bold text-foreground">{processing ? labels.processingTitle : labels.dropTitle}</div>
        <div className="mt-2 text-muted-foreground">{processing ? labels.processingSubtitle : labels.dropSubtitle}</div>
      </div>
    </div>
  );
}
