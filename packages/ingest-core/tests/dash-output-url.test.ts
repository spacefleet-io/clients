/**
 * @bugfix @regression-proof
 *
 * Windows packaged app: ffmpeg's DASH muxer derives the segment directory from
 * the output URL by splitting on "/" only (`strrchr(url, '/')`). A backslash
 * manifest path (`C:\...\manifest.mpd`) therefore made it write `init-*.mp4` /
 * `seg-*.m4s` into the process cwd instead of next to the manifest, and
 * finalize failed with INIT_SEGMENT_MISSING. The output URL handed to ffmpeg
 * must use "/" separators. It stays an absolute path, so the encoder lease
 * (orphan identity check by command line) keeps matching.
 */
import { describe, expect, it } from "vitest";
import { toFfmpegOutputUrl } from "../src/mediaProcessor";

const muxerSegmentDir = (url: string) => url.slice(0, url.lastIndexOf("/") + 1);

describe("@bugfix @regression-proof toFfmpegOutputUrl keeps the DASH muxer inside the output dir", () => {
  it("converts a Windows manifest path so the muxer's '/'-split finds the output dir", () => {
    const windowsPath = "C:\\Users\\sf\\AppData\\Roaming\\@sf\\desktop\\transcode\\u1\\job1\\outputs\\video-720p-h264\\manifest.mpd";
    const url = toFfmpegOutputUrl(windowsPath, "\\");
    console.info("[dash-output-url:windows]", url);
    expect(url).not.toContain("\\");
    expect(muxerSegmentDir(url)).toBe("C:/Users/sf/AppData/Roaming/@sf/desktop/transcode/u1/job1/outputs/video-720p-h264/");
  });

  it("leaves a POSIX path untouched", () => {
    const posixPath = "/home/u/.local/share/transcode/u1/job1/outputs/audio-0/manifest.mpd";
    expect(toFfmpegOutputUrl(posixPath, "/")).toBe(posixPath);
  });
});
