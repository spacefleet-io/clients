// The shipped ffmpeg has no `hls` muxer (only dash/mp4/matroska/...), so tests that need an HLS fixture
// package it with the dash muxer and derive the playlist from the manifest's segment timeline.
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ingest-core-style DASH timeline -> per-segment durations (seconds). */
export const timelineDurations = (mpd: string): number[] => {
  const timescale = Number(/timescale="(\d+)"/.exec(mpd)?.[1] ?? 1);
  const timeline = /<SegmentTimeline[^>]*>([\s\S]*?)<\/SegmentTimeline>/.exec(mpd)?.[1] ?? "";
  const out: number[] = [];
  for (const [, attrs] of timeline.matchAll(/<S\b([^>]*)\/>/g)) {
    const d = Number(/\bd="(\d+)"/.exec(attrs!)?.[1]);
    const r = Math.max(0, Number(/\br="(-?\d+)"/.exec(attrs!)?.[1] ?? 0));
    for (let i = 0; i <= r; i += 1) out.push(d / timescale);
  }
  return out;
};

/**
 * Writes `index.m3u8` (fMP4 VOD) next to a dash muxer output: `manifest.mpd`, `init.mp4` and `seg*.m4s`.
 * The dash muxer numbers segments from 1; the segments are renamed to the hls muxer's 0-based `seg000.m4s`.
 */
export const writeVodPlaylist = (dir: string): void => {
  const durations = timelineDurations(readFileSync(join(dir, "manifest.mpd"), "utf8"));
  const segments = readdirSync(dir).filter((name) => /^seg\d+\.m4s$/.test(name)).sort();
  if (segments.length === 0 || segments.length !== durations.length) {
    throw new Error(`dash output in ${dir}: ${segments.length} segment files for ${durations.length} timeline entries`);
  }
  const names = segments.map((_, index) => `seg${String(index).padStart(3, "0")}.m4s`);
  segments.forEach((name, index) => renameSync(join(dir, name), join(dir, names[index]!)));
  writeFileSync(
    join(dir, "index.m3u8"),
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
      "#EXT-X-PLAYLIST-TYPE:VOD",
      '#EXT-X-MAP:URI="init.mp4"',
      ...names.flatMap((name, index) => [`#EXTINF:${durations[index]!.toFixed(3)},`, name]),
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
  );
};
