/**
 * @req MPV-PREV-01[badger-desktop]
 *
 * The renderer hands the main process the preview record of the file being played: the one on that file's source
 * format (the import stores it there, MPV-PREV-02). Any other row, another file, or no record means no previews.
 */
import { describe, expect, it } from "vitest";
import type { MediaFormat } from "@space/shared/libraryTypes";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { missingPreviewsFor, sourcePreviewSheets } from "../src/renderer/src/lib/mpvExternalMetadata";

const sheets = (key: string): MediaPreviewSheets => ({
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 12,
  sheets: [{ objectKey: key, sizeBytes: 1000, firstPicture: 0, pictureCount: 12 }],
});

const format = (over: Partial<MediaFormat>): MediaFormat => ({
  id: "fmt",
  mediaId: "m1",
  fileId: "file-a",
  quality: "1080p",
  codec: "h264",
  bitrateKbps: null,
  sizeMb: 1,
  initKey: null,
  initSize: null,
  durationSeconds: 60,
  totalSize: null,
  chunks: [],
  ...over,
});

describe("sourcePreviewSheets (MPV-PREV-01)", () => {
  const formats = [
    format({ id: "a-720", fileId: "file-a", quality: "720p", isSource: false, previewSheets: sheets("not-source") }),
    format({ id: "b-src", fileId: "file-b", isSource: true, previewSheets: sheets("file-b") }),
    format({ id: "a-src", fileId: "file-a", isSource: true, previewSheets: sheets("file-a") }),
  ];

  it("picks the playing file's source format", () => {
    expect(sourcePreviewSheets(formats, "file-a")?.sheets[0]?.objectKey).toBe("file-a");
    expect(sourcePreviewSheets(formats, "file-b")?.sheets[0]?.objectKey).toBe("file-b");
  });

  it("is null without a file, without a source row, or when the source row has no record", () => {
    expect(sourcePreviewSheets(formats, null)).toBeNull();
    expect(sourcePreviewSheets([formats[0]!], "file-a")).toBeNull();
    expect(sourcePreviewSheets([format({ isSource: true })], "file-a")).toBeNull();
    expect(sourcePreviewSheets([format({ isSource: true, previewSheets: null })], "file-a")).toBeNull();
  });
});

/**
 * @req MPV-PREV-06[badger-desktop]
 * With no record, the renderer names the playing file's source format (the row the catch-up pass keys its tries on)
 * and the hint text, so the main process can ask the runtime whether previews are still to come.
 */
describe("missingPreviewsFor (MPV-PREV-06)", () => {
  const HINT = "Previews are being prepared";

  it("names the playing file's source format with the hint", () => {
    const formats = [
      format({ id: "a-720", fileId: "file-a", quality: "720p", isSource: false }),
      format({ id: "a-src", fileId: "file-a", isSource: true }),
    ];
    const missing = missingPreviewsFor(formats, "file-a", HINT);
    console.info(`[mpv-preview-sheets-source] missing=${JSON.stringify(missing)}`);
    expect(missing).toEqual({ formatId: "a-src", hint: HINT });
  });

  it("has no format to name without a file or a source row (the OSC then draws nothing)", () => {
    expect(missingPreviewsFor([format({ id: "a-src", isSource: true })], null, HINT)).toEqual({ formatId: null, hint: HINT });
    expect(missingPreviewsFor([format({ id: "a-720", isSource: false })], "file-a", HINT)).toEqual({ formatId: null, hint: HINT });
  });
});
