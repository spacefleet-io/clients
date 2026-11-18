import { describe, expect, it } from "vitest";
import { findMissingComponents, parseComponentListing } from "../src/components";

// Verbatim excerpts of `ffmpeg -hide_banner <list flag>` (ffmpeg 8.1).
const MUXERS = `File formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ..d = Is a device
 ---
  E  dash            DASH Muxer
  E  matroska        Matroska
  Ed alsa            ALSA audio output
`;
const DEMUXERS = `Formats:
 D.. = Demuxing supported
 ---
 D   dash            Dynamic Adaptive Streaming over HTTP
 D d lavfi           Libavfilter virtual input device
 D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
`;
const ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 S..... mov_text             3GPP Timed Text subtitle
`;
const BSFS = `Bitstream filters:
h264_mp4toannexb
hevc_mp4toannexb
`;
const FILTERS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 ... anull             A->A       Pass the source unchanged to the output.
 T.. crop              V->V       Crop the input video.
 ... color             |->V       Provide an uniformly colored input.
 ..C scale_cuda        V->V       GPU accelerated video resizer
 TSC overlay           VV->V      Overlay a video source on top of the input.
`;
const PROTOCOLS = `Supported file protocols:
Input:
  async
  file
  http
Output:
  file
  pipe
`;

describe("component listing parser", () => {
  it("reads codec, format, device, alias, filter, bsf and protocol rows", () => {
    expect([...parseComponentListing("muxer", MUXERS)]).toEqual(expect.arrayContaining(["dash", "matroska", "alsa"]));
    expect([...parseComponentListing("demuxer", DEMUXERS)]).toEqual(expect.arrayContaining(["dash", "lavfi", "mov", "mp4"]));
    expect(parseComponentListing("demuxer", DEMUXERS).has("d")).toBe(false);
    expect([...parseComponentListing("encoder", ENCODERS)]).toEqual(expect.arrayContaining(["libx264", "h264vaapi", "movtext"]));
    expect([...parseComponentListing("bsf", BSFS)]).toEqual(["h264mp4toannexb", "hevcmp4toannexb"]);
    expect([...parseComponentListing("filter", FILTERS)]).toEqual(
      expect.arrayContaining(["anull", "crop", "color", "scalecuda", "overlay"])
    );
    expect([...parseComponentListing("protocol", PROTOCOLS)].sort()).toEqual(["async", "file", "http", "pipe"]);
  });

  it("does not mistake the legend lines of -filters for filter names", () => {
    const names = parseComponentListing("filter", FILTERS);
    expect(names.has("timelinesupport")).toBe(false);
    expect(names.has("")).toBe(false);
    expect(names.size).toBe(5);
  });

  it("does not take protocol headers as protocol names", () => {
    const names = parseComponentListing("protocol", PROTOCOLS);
    expect(names.has("input")).toBe(false);
  });
});

// @bugfix @regression-proof (issue #25, review of PR #41): the old verifier only compared
// decoders and demuxers, so a binary missing a muxer the ingest writes passed verification and shipped.
describe("component verification", () => {
  it("reports an enabled component the build lacks, per kind", () => {
    const flags = [
      "--enable-muxer=matroska",
      "--enable-muxer=sup",
      "--enable-filter=crop",
      "--enable-filter=hwdownload",
      "--enable-protocol=pipe",
      "--enable-protocol=crypto",
    ];
    expect(findMissingComponents(flags, { muxer: MUXERS, filter: FILTERS, protocol: PROTOCOLS })).toEqual([
      "--enable-muxer=sup",
      "--enable-filter=hwdownload",
      "--enable-protocol=crypto",
    ]);
  });

  it("checks indev against the demuxer listing and skips kinds ffmpeg cannot list", () => {
    const flags = ["--enable-indev=lavfi", "--enable-parser=h264", "--enable-hwaccel=h264_nvdec", "--enable-libx264"];
    expect(findMissingComponents(flags, { demuxer: DEMUXERS })).toEqual([]);
    expect(findMissingComponents(["--enable-indev=lavfi"], {})).toEqual(["--enable-indev=lavfi"]);
  });

  it("matches configure's underscore-free names (movtext vs mov_text)", () => {
    expect(findMissingComponents(["--enable-encoder=movtext", "--enable-bsf=h264_mp4toannexb"], { encoder: ENCODERS, bsf: BSFS })).toEqual([]);
  });

  it("treats a kind with no collected listing as entirely missing", () => {
    expect(findMissingComponents(["--enable-bsf=h264_mp4toannexb"], {})).toEqual(["--enable-bsf=h264_mp4toannexb"]);
  });
});

// @bugfix @regression-proof (first real linux-x64 build): ffmpeg 8.1 prints some listings differently than
// the verifier assumed, which reported 20 present components as missing.
describe("real ffmpeg 8.1 listing quirks", () => {
  const FILTERS_TWO_FLAGS = `Filters:
 .. aformat           A->A       Convert the input audio to one of the specified formats.
 .S astats            A->A       Show time domain statistics about audio frames.
 .. scale             V->V       Scale the input video size.
`;
  it("parses filter rows that carry two flag columns", () => {
    expect([...parseComponentListing("filter", FILTERS_TWO_FLAGS)].sort()).toEqual(["aformat", "astats", "scale"]);
  });

  it("finds a decoder listed under another name through its '(codec …)' note", () => {
    const decoders = ` V...BD msmpeg4              MPEG-4 part 2 Microsoft variant version 3 (codec msmpeg4v3)\n`;
    expect(findMissingComponents(["--enable-decoder=msmpeg4v3"], { decoder: decoders })).toEqual([]);
  });

  it("maps the mpegps demuxer to its listed name and skips the never-listed image pipe demuxers", () => {
    const demuxers = ` D   mpeg            MPEG-PS (MPEG-2 Program Stream)\n`;
    expect(findMissingComponents(["--enable-demuxer=mpegps", "--enable-demuxer=image_jpeg_pipe"], { demuxer: demuxers })).toEqual([]);
    expect(findMissingComponents(["--enable-demuxer=mpegps"], { demuxer: " D   mp3   MP3\n" })).toEqual(["--enable-demuxer=mpegps"]);
  });
});
