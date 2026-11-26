// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-WINDOW-DROP-001
 * @why UX-ADD-01 (Chris 2026-11-09): "Parrot desktop should have the same drag and drop as Badger". Both apps take
 *   files or folders dropped anywhere on the window through this one hook and overlay; an open dialog (Parrot's edit
 *   dialog) or an own drop (Badger's poster field in edit mode) keeps its own drop in both apps.
 * @why UX-ADD-02 (Chris 2026-11-11): a cast photo or a website image dragged onto Badger showed the drop overlay and
 *   opened an empty import; "Ignoring images altogether could be a good option". Only real external files show the
 *   overlay, images are left out silently, other files the app cannot import get a toast.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isExternalFileDrag,
  OWN_FILE_DROP,
  sortDrop,
  useWindowFileDrop,
  WindowDropOverlay,
  type WindowFileDrop,
  type WindowFileDropOptions,
} from "../src/window-drop";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no DataTransfer: the fields the drop code reads. */
const transfer = ({ files = [] as File[], uris = "", folders = [] as string[] } = {}): DataTransfer =>
  ({
    types: [...(files.length ? ["Files"] : []), ...(uris ? ["text/uri-list"] : [])],
    files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: folders.includes(file.name) }),
    })),
    getData: (type: string) => (type === "text/uri-list" ? uris : ""),
    dropEffect: "none",
  }) as unknown as DataTransfer;

const dragEvent = (type: string, dataTransfer: DataTransfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
};

const fileAt = (name: string, path: string) => Object.assign(new File(["x"], name), { path });
const video = (name: string) => new File(["v"], name, { type: "video/x-matroska" });
const image = (name: string, type = "image/jpeg") => new File(["i"], name, { type });
/** Badger's filter: videos and subtitles. */
const isMedia = (path: string) => /\.(mkv|mp4|srt)$/i.test(path);
const onDisk = (file: File) => (file.name.startsWith("web-") ? "" : `/drop/${file.name}`);

// @req UX-ADD-02[badger-desktop,parrot]: the drop filter both apps' window drop uses.
describe("sortDrop", () => {
  it("reads each dropped file's path once, through the preload's getPathForFile first", () => {
    const files = [video("a.mkv"), new File(["b"], "Season 1"), video("a.mkv")];
    const sorted = sortDrop(transfer({ files, folders: ["Season 1"] }), isMedia, (file) => `/media/${file.name}`);
    console.log("[window-drop.test] sorted", JSON.stringify(sorted));
    expect(sorted).toEqual({ importable: ["/media/a.mkv", "/media/Season 1"], images: [], refused: [] });
  });

  it("falls back to File.path, then to file:// URIs (decoded, comments skipped, a name with no extension is a folder)", () => {
    expect(sortDrop(transfer({ files: [fileAt("x.mkv", "/old/x.mkv")] }), isMedia).importable).toEqual(["/old/x.mkv"]);
    const uris = "# comment\nfile:///home/me/My%20Show\nhttps://example.com/x\nfile:///home/me/ep.mkv\nfile:///home/me/notes.pdf";
    expect(sortDrop(transfer({ uris }), isMedia)).toEqual({ importable: ["/home/me/My Show", "/home/me/ep.mkv"], images: [], refused: ["/home/me/notes.pdf"] });
    expect(sortDrop(null, isMedia)).toEqual({ importable: [], images: [], refused: [] });
  });

  it("[@bugfix][@regression-proof] reads a Windows file:// URI as a drive or network path, never as /C:/…", () => {
    // Windows run 2026-11-13: a dropped folder's URI became /C:/Users/…, the scan found 0 songs.
    const uris = "file:///C:/Users/sf/AppData/Local/Temp/Drop%20Album\r\nfile:///c:/Videos/ep.mkv\r\nfile://nas/share/Live%20Set\r\nfile://localhost/D:/Videos/b.mkv";
    expect(sortDrop(transfer({ uris }), isMedia).importable).toEqual(["C:\\Users\\sf\\AppData\\Local\\Temp\\Drop Album", "c:\\Videos\\ep.mkv", "\\\\nas\\share\\Live Set", "D:\\Videos\\b.mkv"]);
    expect(sortDrop(transfer({ uris: "file://localhost/home/me/Show" }), isMedia).importable).toEqual(["/home/me/Show"]);
  });

  it("leaves images out silently: alone, mixed with media, by MIME type or by extension", () => {
    const onlyImages = sortDrop(transfer({ files: [image("cover.jpg"), image("poster", "image/png")] }), isMedia, onDisk);
    expect(onlyImages).toEqual({ importable: [], images: ["/drop/cover.jpg", "/drop/poster"], refused: [] });
    const mixed = sortDrop(transfer({ files: [video("ep1.mkv"), image("fanart.png", ""), new File(["s"], "ep1.srt")] }), isMedia, onDisk);
    expect(mixed).toEqual({ importable: ["/drop/ep1.mkv", "/drop/ep1.srt"], images: ["/drop/fanart.png"], refused: [] });
  });

  it("refuses other files, and a website file with no path on disk", () => {
    const pdf = new File(["p"], "manual.pdf", { type: "application/pdf" });
    expect(sortDrop(transfer({ files: [pdf, video("ep.mkv")] }), isMedia, onDisk)).toEqual({ importable: ["/drop/ep.mkv"], images: [], refused: ["/drop/manual.pdf"] });
    expect(sortDrop(transfer({ files: [new File(["v"], "web-clip.mkv")] }), isMedia, onDisk)).toEqual({ importable: [], images: [], refused: ["web-clip.mkv"] });
    // A website image has no path either: it is still only an image.
    expect(sortDrop(transfer({ files: [image("web-photo.jpg")] }), isMedia, onDisk).images).toEqual(["web-photo.jpg"]);
  });
});

describe("isExternalFileDrag", () => {
  it("takes real files and folders, never an image-only drag or a drag without files", () => {
    expect(isExternalFileDrag(transfer({ files: [video("a.mkv")] }))).toBe(true);
    expect(isExternalFileDrag(transfer({ files: [new File([""], "Season 1")] }))).toBe(true);
    expect(isExternalFileDrag(transfer({ files: [image("cast.jpg"), video("a.mkv")] }))).toBe(true);
    // A browser image (or a picture from the file manager): files, but only images.
    expect(isExternalFileDrag(transfer({ files: [image("photo.webp", "image/webp")] }))).toBe(false);
    // A link or image dragged from a page with no file: only URIs and text.
    expect(isExternalFileDrag(transfer({ uris: "https://example.com/photo.jpg" }))).toBe(false);
    expect(isExternalFileDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });
});

describe("useWindowFileDrop + WindowDropOverlay", () => {
  let host: HTMLDivElement;
  let root: Root;

  const Harness = (props: Omit<WindowFileDropOptions, "isImportableFile"> & { isImportableFile?: WindowFileDropOptions["isImportableFile"] }) => {
    const options = { isImportableFile: isMedia, ...props };
    const drop = useWindowFileDrop(options);
    return (
      <>
        <div data-testid="own-drop" />
        <WindowDropOverlay drop={drop} labels={{ dropTitle: "Drop here", dropSubtitle: "Files or folders", processingTitle: "Reading", processingSubtitle: "Wait" }} />
      </>
    );
  };
  const overlay = () => host.querySelector<HTMLElement>('[data-testid="window-drop-overlay"]')!;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("shows the overlay while files are dragged over the window and hands the drop's paths over", () => {
    const onDrop = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} getPathForFile={(file) => `/drop/${file.name}`} />));
    expect(overlay().dataset.state).toBe("hidden");

    const dt = transfer({ files: [new File(["a"], "Album")], folders: ["Album"] });
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
    });
    expect(overlay().dataset.state).toBe("dragging");
    expect(overlay().textContent).toContain("Drop here");

    const dropEvent = dragEvent("drop", dt);
    act(() => {
      document.body.dispatchEvent(dropEvent);
    });
    console.log("[window-drop.test] onDrop calls", JSON.stringify(onDrop.mock.calls));
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledWith(["/drop/Album"]);
    expect(overlay().dataset.state).toBe("processing");
    expect(overlay().textContent).toContain("Reading");

    // Never stuck: the overlay goes on its own if nothing says the next screen is up.
    act(() => vi.advanceTimersByTime(10_000));
    expect(overlay().dataset.state).toBe("hidden");
  });

  it("hides the overlay once every dragenter has its dragleave, and ignores non-file drags", () => {
    const onDrop = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} />));
    const dt = transfer({ files: [video("a.mkv")] });
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      host.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(dragEvent("dragleave", dt));
    });
    expect(overlay().dataset.state).toBe("dragging");
    act(() => {
      host.dispatchEvent(dragEvent("dragleave", dt));
    });
    expect(overlay().dataset.state).toBe("hidden");

    const text = { types: ["text/plain"], getData: () => "hi" } as unknown as DataTransfer;
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", text));
      document.body.dispatchEvent(dragEvent("drop", text));
    });
    expect(overlay().dataset.state).toBe("hidden");
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("stands aside when the app says so: no overlay, and the element under the pointer still gets the drop", () => {
    const onDrop = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} standAside={() => true} />));
    const own = host.querySelector('[data-testid="own-drop"]')!;
    const ownDrop = vi.fn();
    own.addEventListener("drop", ownDrop);
    const dt = transfer({ files: [new File(["c"], "cover.png")] });
    const dropEvent = dragEvent("drop", dt);
    act(() => {
      own.dispatchEvent(dragEvent("dragenter", dt));
      own.dispatchEvent(dropEvent);
    });
    expect(overlay().dataset.state).toBe("hidden");
    expect(onDrop).not.toHaveBeenCalled();
    expect(ownDrop).toHaveBeenCalledTimes(1);
    // The window itself never opens the dropped file.
    expect(dropEvent.defaultPrevented).toBe(true);
  });

  it.each([
    ["an open dialog (Parrot's edit dialog)", { role: "dialog" }],
    ["an own drop on screen (Badger's poster field in edit mode)", OWN_FILE_DROP],
  ])("stands aside while %s is on screen, with no app option", (_name, attributes: Record<string, string>) => {
    const onDrop = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} getPathForFile={onDisk} />));
    const dialog = document.createElement("div");
    for (const [name, value] of Object.entries(attributes)) dialog.setAttribute(name, value);
    const poster = document.createElement("div");
    dialog.appendChild(poster);
    document.body.appendChild(dialog);
    const posterDrop = vi.fn();
    poster.addEventListener("drop", posterDrop);
    const dt = transfer({ files: [video("poster.mkv")] });
    const dropEvent = dragEvent("drop", dt);
    act(() => {
      poster.dispatchEvent(dragEvent("dragenter", dt));
      poster.dispatchEvent(dropEvent);
    });
    expect(overlay().dataset.state).toBe("hidden");
    expect(onDrop).not.toHaveBeenCalled();
    expect(posterDrop).toHaveBeenCalledTimes(1);
    expect(dropEvent.defaultPrevented).toBe(true);

    // Once it is gone, a drop on the window is the window's again.
    dialog.remove();
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(dragEvent("drop", dt));
    });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("ignores an image-only drag completely: no overlay, no toast, nothing dropped, and the window never opens it", () => {
    const onDrop = vi.fn();
    const onRefused = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} onRefused={onRefused} getPathForFile={onDisk} />));
    const dt = transfer({ files: [image("web-photo.jpg")] });
    const over = dragEvent("dragover", dt);
    const dropEvent = dragEvent("drop", dt);
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(over);
    });
    expect(overlay().dataset.state).toBe("hidden");
    expect(dt.dropEffect).toBe("none");
    act(() => {
      document.body.dispatchEvent(dropEvent);
    });
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(overlay().dataset.state).toBe("hidden");
    expect(onDrop).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("drops images mixed with media silently, and says so for a PDF without opening anything", () => {
    const onDrop = vi.fn();
    const onRefused = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} onRefused={onRefused} getPathForFile={onDisk} />));
    const mixed = transfer({ files: [image("cover.jpg"), video("ep1.mkv")] });
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", mixed));
      document.body.dispatchEvent(dragEvent("drop", mixed));
    });
    expect(onDrop).toHaveBeenCalledWith(["/drop/ep1.mkv"]);
    expect(onRefused).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(10_000));

    const pdf = transfer({ files: [new File(["p"], "manual.pdf", { type: "application/pdf" })] });
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", pdf));
    });
    // A PDF is a real file: the overlay shows while it is dragged, the drop says it cannot be added.
    expect(overlay().dataset.state).toBe("dragging");
    act(() => {
      document.body.dispatchEvent(dragEvent("drop", pdf));
    });
    expect(onRefused).toHaveBeenCalledWith(["manual.pdf"]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(overlay().dataset.state).toBe("hidden");
  });

  it("never lets an in-app image or link be dragged, and ignores any other drag that starts inside the window", () => {
    const onDrop = vi.fn();
    act(() => root.render(<Harness onDrop={onDrop} />));
    const cast = document.createElement("img");
    const link = document.createElement("a");
    const label = document.createElement("span");
    link.appendChild(label);
    const row = document.createElement("div");
    document.body.append(cast, link, row);
    const start = (target: Element) => {
      const event = new Event("dragstart", { bubbles: true, cancelable: true });
      act(() => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(start(cast)).toBe(true);
    expect(start(label)).toBe(true);

    // Chromium hands an in-app drag its own files: still not a drop for the window.
    expect(start(row)).toBe(false);
    const dt = transfer({ files: [video("inside.mkv")] });
    act(() => {
      row.dispatchEvent(dragEvent("dragenter", dt));
      row.dispatchEvent(dragEvent("drop", dt));
    });
    expect(overlay().dataset.state).toBe("hidden");
    expect(onDrop).not.toHaveBeenCalled();
    cast.remove();
    link.remove();
    row.remove();
  });

  it("[@bugfix][@regression-proof] takes a drop from the file manager after an in-app drag that never got its dragend (UX-ADD-01)", () => {
    // Chris, Parrot 0.1.69 on KDE Wayland: "drag and drop doesn't work anymore". A drag that starts in the window and
    // ends somewhere Chromium sends no dragend (outside the window, over a dialog, a compositor-cancelled drag) used
    // to leave the hook thinking every later drag was its own: the file manager's files got "none" and no drop.
    const onDrop = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => root.render(<Harness onDrop={onDrop} getPathForFile={(file) => `/drop/${file.name}`} />));
    const row = document.createElement("div");
    document.body.append(row);
    act(() => {
      row.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    });
    // No dragend. The pointer moves again: mouse events never fire during a drag, so that drag is over.
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });

    const dt = transfer({ files: [new File(["a"], "Album")], folders: ["Album"] });
    const over = dragEvent("dragover", dt);
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(over);
    });
    console.log("[window-drop.test] after stale dragstart: overlay", overlay().dataset.state, "dropEffect", dt.dropEffect);
    expect(overlay().dataset.state).toBe("dragging");
    expect(dt.dropEffect).toBe("copy");
    act(() => {
      document.body.dispatchEvent(dragEvent("drop", dt));
    });
    console.log("[window-drop.test] onDrop calls", JSON.stringify(onDrop.mock.calls), "warnings", JSON.stringify(warn.mock.calls));
    expect(onDrop).toHaveBeenCalledWith(["/drop/Album"]);
    warn.mockRestore();
    row.remove();
  });

  it("says in a warning (forwarded to the main log) why a file drag is not taken, once per reason, and what a drop held", () => {
    const onDrop = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let aside = false;
    act(() => root.render(<Harness onDrop={onDrop} standAside={() => aside} getPathForFile={(file) => `/drop/${file.name}`} />));
    const dt = transfer({ files: [video("ep.mkv")] });
    const lines = () => warn.mock.calls.map((call) => String(call[0]));

    // A dialog that takes its own drops is on screen.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.testid = "edit-dialog";
    document.body.append(dialog);
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(dragEvent("dragover", dt));
      document.body.dispatchEvent(dragEvent("dragover", dt));
    });
    console.log("[window-drop.test] dialog warnings", JSON.stringify(lines()));
    expect(lines().filter((line) => line.includes("stands aside"))).toHaveLength(1);
    expect(lines()[0]).toContain('role="dialog"');
    expect(lines()[0]).toContain("edit-dialog");
    dialog.remove();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });

    // The app asks the window drop to stand aside (an import already running).
    aside = true;
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
    });
    console.log("[window-drop.test] standAside warnings", JSON.stringify(lines()));
    expect(lines().at(-1)).toContain("the app asked it to stand aside");
    aside = false;
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });

    // A drag that started in the window.
    const row = document.createElement("div");
    document.body.append(row);
    act(() => {
      row.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
      row.dispatchEvent(dragEvent("dragenter", dt));
    });
    console.log("[window-drop.test] internal warnings", JSON.stringify(lines()));
    expect(lines().at(-1)).toContain("started inside the window");
    act(() => {
      row.dispatchEvent(new Event("dragend", { bubbles: true }));
    });
    row.remove();

    // A taken drop says what it held.
    act(() => {
      document.body.dispatchEvent(dragEvent("dragenter", dt));
      document.body.dispatchEvent(dragEvent("drop", dt));
    });
    console.log("[window-drop.test] drop warnings", JSON.stringify(lines()));
    expect(onDrop).toHaveBeenCalledWith(["/drop/ep.mkv"]);
    expect(lines().at(-1)).toContain("[window-drop] 1 importable");
    warn.mockRestore();
  });

  it("startProcessing/stopProcessing drive the overlay for drops that arrive another way", () => {
    let api: WindowFileDrop | null = null;
    const Probe = () => {
      api = useWindowFileDrop({ onDrop: () => {}, isImportableFile: isMedia });
      return <WindowDropOverlay drop={api} labels={{ dropTitle: "", dropSubtitle: "", processingTitle: "Reading", processingSubtitle: "" }} />;
    };
    act(() => root.render(<Probe />));
    act(() => api!.startProcessing());
    expect(overlay().dataset.state).toBe("processing");
    act(() => api!.stopProcessing());
    expect(overlay().dataset.state).toBe("hidden");
  });
});
