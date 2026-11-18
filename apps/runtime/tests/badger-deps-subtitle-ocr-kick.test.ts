/**
 * @req PLAY-TRACK-05[runtime]
 *
 * The commit step wakes the subtitle OCR worker once per commit that wrote a
 * picture subtitle row (PGS / VobSub / DVB), never for text-only commits, and
 * a throwing hook never fails the commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";

const produced = (subtitleTracks: ProducedMedia["subtitleTracks"]): ProducedMedia => ({
  videoFormats: [
    {
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      initKey: "media/silo_abc12345/init",
      initSize: 10,
      durationSeconds: 60,
      totalSize: 20,
      chunks: [{ key: "media/silo_abc12345/seg-1", sizeBytes: 10, startSeconds: 0 }],
    },
  ],
  audioTracks: [],
  subtitleTracks,
});

const buildLibraryDb = () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === "getMediaDetails") return { id: "media-1", title: "Movie", type: "movie" };
      if (method === "linkFileToMedia") return "file-1";
      if (method === "addMediaFormat") return "fmt-1";
      return null;
    }),
  } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];
  return { libraryDb, calls };
};

const processMediaJob = vi.fn(async () => {
  throw new Error("processMediaJob is not part of a commit");
}) as unknown as ProcessMediaJobFn;

const commit = async (
  tracks: ProducedMedia["subtitleTracks"],
  hook: (info: { mediaId: string; count: number }) => void
) => {
  const { libraryDb, calls } = buildLibraryDb();
  const deps = buildBadgerStepDeps({
    libraryDb,
    processMediaJob,
    resolveToken: () => "test-token",
    resolveLibraryKey: () => "lk",
    warmStorageCacheImpl: async () => ({ dispatched: 0, ok: true }),
    onPictureSubtitlesCommitted: hook,
  });
  const result = await deps.commit({
    userId: "u-ocr",
    jobId: "j-ocr",
    mediaId: "media-1",
    filename: "movie.mkv",
    scope: "source",
    produced: produced(tracks),
    signal: new AbortController().signal,
  });
  return { result, calls };
};

beforeEach(() => __resetBadgerStepDepsAdapter());
afterEach(() => __resetBadgerStepDepsAdapter());

describe("commit → subtitle OCR kick (PLAY-TRACK-05)", () => {
  it("calls the hook once with the count of picture rows written", async () => {
    const hook = vi.fn();
    const { result, calls } = await commit(
      [
        { language: "fr", label: "Français", objectKey: "media/silo_abc12345/sub-fr.mkv", format: "dvd_subtitle" },
        { language: "en", label: "English", objectKey: "media/silo_abc12345/sub-en.sup", format: "SUP" },
        { language: "en", label: "English SDH", objectKey: "media/silo_abc12345/sub-en.vtt", format: "vtt" },
      ],
      hook
    );

    expect(result.fileId).toBe("file-1");
    expect(calls.filter((c) => c.method === "addSubtitleTrackWithObject")).toHaveLength(3);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ mediaId: "media-1", count: 2 });
  });

  it("does not call the hook for text-only subtitles", async () => {
    const hook = vi.fn();
    await commit([{ language: "en", label: "English", objectKey: "media/silo_abc12345/sub.vtt", format: "vtt" }], hook);
    await commit([], hook);
    expect(hook).not.toHaveBeenCalled();
  });

  it("a throwing hook never fails the commit", async () => {
    const warn = vi.spyOn(console, "warn");
    const { result } = await commit(
      [{ language: "fr", label: "Français", objectKey: "media/silo_abc12345/sub.sup", format: "hdmv_pgs_subtitle" }],
      () => {
        throw new Error("worker gone");
      }
    );

    expect(result.fileId).toBe("file-1");
    expect(result.formatIds).toEqual(["fmt-1"]);
    expect(warn.mock.calls.some((args) => String(args[0]).startsWith("[subtitle-ocr] commit.kick_failed"))).toBe(true);
  });
});
