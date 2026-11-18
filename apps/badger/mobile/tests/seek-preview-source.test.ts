/**
 * @test-id MOBILE-SEEK-PREVIEW-SOURCE-001
 * @level unit
 *
 * MPV-PREV-01 on the phone and the TV: the player finds the picture of a moment in the library record
 * (`locatePreviewPicture`), loads its sheet through the playback proxy at most once per playback, keeps it in memory
 * only, and prefetches the neighbouring sheet when the pointer nears a sheet's edge. A title without previews, or with
 * a malformed record, gets no source at all, so the seek bar stays exactly as it was.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { previewPictureLayout, previewLeft } from "@space/mobile-mpv-playback/seekPreview";
import { createSeekPreviewSource, loadSheetDataUri, previewSheetsForFile } from "../src/lib/playback/seekPreviewSource";
import { playbackObjectUrl } from "../src/lib/playback/sidecarSubtitle";

const TAG = "[seek-preview-source]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase} ${JSON.stringify(data)}`);

const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 240,
  sheets: [
    { objectKey: "previews/sheet-0", sizeBytes: 164_000, firstPicture: 0, pictureCount: 100 },
    { objectKey: "previews/sheet-1", sizeBytes: 167_000, firstPicture: 100, pictureCount: 100 },
    { objectKey: "previews/sheet-2", sizeBytes: 68_000, firstPicture: 200, pictureCount: 40 },
  ],
};

const PLAY_URL = "http://127.0.0.1:38123/playback/master.m3u8";

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
};

const harness = (previews: unknown, fail = new Set<string>()) => {
  const loads: string[] = [];
  const loadSheet = vi.fn(async (url: string) => {
    loads.push(url);
    if ([...fail].some((key) => url.endsWith(encodeURIComponent(key)))) throw new Error("gateway 502");
    return `data:image/jpeg;base64,${Buffer.from(url).toString("base64")}`;
  });
  const source = createSeekPreviewSource({
    previews: previews as MediaPreviewSheets,
    sheetUrl: (key) => playbackObjectUrl(PLAY_URL, key),
    loadSheet,
  });
  return { source, loads, loadSheet };
};

describe("seek-bar preview source (MPV-PREV-01)", () => {
  // @req MPV-PREV-01
  it("locates the picture of a moment and crops it out of its loaded sheet", async () => {
    const { source, loads } = harness(PREVIEWS);
    expect(source).not.toBeNull();
    // 12:47 = 767 s -> picture 153 -> sheet 1, picture 53 in it -> column 3, row 5.
    expect(source!.frameAt(767), "nothing drawn before its sheet is loaded").toBeNull();
    source!.want(767);
    await flush();
    const frame = source!.frameAt(767);
    log("frame", { loads, frame: frame && { ...frame, uri: frame.uri.slice(0, 30) } });
    expect(loads[0]).toBe("http://127.0.0.1:38123/playback/object/previews%2Fsheet-1");
    expect(frame).toMatchObject({ x: 3 * 160, y: 5 * 90, width: 160, height: 90, sheetWidth: 1600, sheetHeight: 900 });
    expect(frame?.uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    // The last sheet holds 40 pictures: 4 rows tall.
    source!.want(1199);
    await flush();
    expect(source!.frameAt(1199)).toMatchObject({ x: 9 * 160, y: 3 * 90, sheetHeight: 360 });
    // Past the end clamps to the last picture; before the start to the first.
    expect(source!.frameAt(5000)).toMatchObject({ x: 9 * 160, y: 3 * 90 });
  });

  // @req MPV-PREV-01
  it("fetches each sheet at most once per playback, a failed one included, and prefetches the neighbour near an edge", async () => {
    const { source, loads } = harness(PREVIEWS, new Set(["previews/sheet-0"]));
    source!.want(100); // picture 20 of sheet 0: no neighbour needed
    source!.want(105);
    await flush();
    expect(loads, "a failed sheet is not fetched again").toEqual(["http://127.0.0.1:38123/playback/object/previews%2Fsheet-0"]);
    expect(source!.frameAt(100), "a failed sheet draws nothing").toBeNull();
    source!.want(100);
    source!.want(460); // picture 92 of sheet 0: near its end -> sheet 1 prefetched
    await flush();
    log("loads", loads);
    expect(loads).toEqual([
      "http://127.0.0.1:38123/playback/object/previews%2Fsheet-0",
      "http://127.0.0.1:38123/playback/object/previews%2Fsheet-1",
    ]);
    source!.want(505); // picture 101 of sheet 1: near its start -> sheet 0 already asked, nothing new
    source!.want(980); // picture 196 of sheet 1: near its end -> sheet 2
    await flush();
    expect(loads).toHaveLength(3);
    expect(loads[2]).toMatch(/sheet-2$/);
  });

  // @req MPV-PREV-01
  it("tells the controls when a sheet arrives so they redraw", async () => {
    const { source } = harness(PREVIEWS);
    const listener = vi.fn();
    const unsubscribe = source!.subscribe(listener);
    source!.want(0);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    source!.want(700);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // @req MPV-PREV-01
  it("no previews or a malformed record: no source, so the bar behaves as before", () => {
    expect(harness(null).source).toBeNull();
    expect(harness(undefined).source).toBeNull();
    expect(harness({ ...PREVIEWS, sheets: [] }).source).toBeNull();
    expect(harness({ version: 1, sheets: "nope" }).source).toBeNull();
    expect(harness("{not json").source).toBeNull();
  });

  // @req MPV-PREV-01
  it("takes the record from whichever format of the played file carries it (the source copy)", () => {
    const formats = [
      { fileId: "file-1", quality: "360p" },
      { fileId: "file-2", quality: "1080p", previewSheets: { ...PREVIEWS, pictureCount: 7 } },
      { fileId: "file-1", quality: "1080p", previewSheets: PREVIEWS },
    ];
    expect(previewSheetsForFile(formats, "file-1")).toEqual(PREVIEWS);
    expect(previewSheetsForFile(formats, "file-3")).toBeNull();
  });

  // @req MPV-PREV-01
  it("clips one picture out of the sheet, scaled to the width shown, and keeps it over the bar", () => {
    const layout = previewPictureLayout({ uri: "data:", sheetWidth: 1600, sheetHeight: 900, x: 480, y: 450, width: 160, height: 90 }, 208);
    log("layout", layout);
    expect(layout.box).toEqual({ width: 208, height: 117 });
    expect(layout.image).toEqual({ width: 2080, height: 1170, left: -624, top: -585 });
    expect(previewLeft(500, 160, 1000)).toBe(420);
    expect(previewLeft(10, 160, 1000)).toBe(0);
    expect(previewLeft(990, 160, 1000)).toBe(840);
  });
});

describe("loading a sheet from the playback proxy (MPV-PREV-01)", () => {
  /** React Native's fetched blob: `close()` frees its native bytes. */
  type FakeBlob = { close: Mock };
  const fakeBlob = (): FakeBlob => ({ close: vi.fn() });
  /** The reader hands back the proxy's content type, `application/octet-stream`, as RN's FileReader does. */
  const stubReader = (dataUrl: string) => {
    class FakeFileReader {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.result = dataUrl;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("FileReader", FakeFileReader);
  };
  const stubFetch = (blob: FakeBlob, status = 200) => {
    const fetch = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, blob: async () => blob }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // @req MPV-PREV-01[badger-mobile]
  it("returns the sheet as an in-memory JPEG data URI and frees the native blob", async () => {
    const blob = fakeBlob();
    const fetch = stubFetch(blob);
    stubReader("data:application/octet-stream;base64,/9j/4AAQ");
    const uri = await loadSheetDataUri("http://127.0.0.1:4000/playback/object/previews%2Fsheet-0");
    log("loaded", { uri });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4000/playback/object/previews%2Fsheet-0");
    expect(uri).toBe("data:image/jpeg;base64,/9j/4AAQ");
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  // @req MPV-PREV-01[badger-mobile]
  it("rejects an empty body and still frees the blob", async () => {
    const blob = fakeBlob();
    stubFetch(blob);
    stubReader("data:application/octet-stream;base64,");
    await expect(loadSheetDataUri("http://127.0.0.1:4000/playback/object/k")).rejects.toThrow("sheet_empty");
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  // @req MPV-PREV-01[badger-mobile]
  it("rejects a failed proxy answer without reading it", async () => {
    const blob = fakeBlob();
    stubFetch(blob, 502);
    stubReader("data:application/octet-stream;base64,/9j/");
    await expect(loadSheetDataUri("http://127.0.0.1:4000/playback/object/k")).rejects.toThrow("sheet_http_502");
    expect(blob.close).not.toHaveBeenCalled();
  });
});
