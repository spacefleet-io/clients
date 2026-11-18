/**
 * Deterministic synthetic fixture generator for the runtime-jobs v2 ingest
 * refactor (plan §11 + §rollout-Phase-F, spec §8.4).
 *
 * Why: the e2e + layer-4 release gates need a known-shape fixture corpus that
 *      exercises every code path the new engine supports — movie, TV pair,
 *      multi-audio, text subtitles, image subtitles, undefined-language audio,
 *      no-audio source, corrupt media, large file, tiny file. We refuse to
 *      commit large binary blobs, so each fixture is synthesized from
 *      `ffmpeg lavfi` sources at test-suite startup into a `.cache/`
 *      directory that is gitignored.
 *
 * Determinism contract: same ffmpeg invocation against the same ffmpeg build
 *      should produce byte-stable outputs. We use:
 *        - lavfi virtual sources (no system clock dependency)
 *        - explicit -t durations
 *        - constant bitrate or `-qp` rate-control to remove rate-control
 *          jitter from the codec
 *        - `-fflags +bitexact -flags:v +bitexact -flags:a +bitexact`
 *        - no metadata muxer fields (creation_time stripped via `-map_metadata -1`)
 *      Cross-ffmpeg-version reproducibility is not promised — the corpus is
 *      regenerated per CI runner.
 *
 * Idempotence: each fixture is skipped if already present and non-empty.
 *      Pass `--force` to regenerate.
 *
 * Usage:
 *      bun run packages/ingest-core/scripts/generate-v2-fixtures.ts
 *      bun run packages/ingest-core/scripts/generate-v2-fixtures.ts --force
 *
 * Output dir: packages/ingest-core/fixtures/ingest/v2-synthetic/.cache/
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, copyFileSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const OUT_DIR = resolve(PKG_ROOT, "fixtures/ingest/v2-synthetic/.cache");

const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }
}

function shouldSkip(path: string) {
  if (FORCE) return false;
  if (!existsSync(path)) return false;
  try {
    const s = statSync(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[], label: string) {
  // Determinism flags must straddle inputs/outputs correctly:
  //   -fflags +bitexact is a global/input flag → at the very front
  //   -flags:v / -flags:a / -map_metadata -1 are output flags → injected just
  //   before the trailing output path (last element of args)
  if (args.length === 0) throw new Error(`empty args for ${label}`);
  const outPath = args[args.length - 1];
  const inputAndCodec = args.slice(0, -1);
  const fullArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-fflags", "+bitexact",
    ...inputAndCodec,
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-map_metadata", "-1",
    outPath,
  ];
  const r = spawnSync("ffmpeg", fullArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed for ${label} (exit ${r.status})`);
  }
}

// ---------------------------------------------------------------------------
// Fixture recipes
// ---------------------------------------------------------------------------

type Recipe = {
  name: string;
  description: string;
  build(outPath: string): void;
};

const recipes: Recipe[] = [
  // 1. Default movie fixture
  {
    name: "movie.mkv",
    description: "5s color video + 1 EN audio + 1 EN text subtitle. Default representative.",
    build(out) {
      // Use a synthetic SRT input piped via concat-friendly route. ffmpeg
      // cannot synthesize subtitle text from lavfi, so we emit a 1-line srt
      // sidecar in tmp, mux it into the mkv, then drop it.
      const srt = join(OUT_DIR, "_tmp.movie.en.srt");
      writeSrt(srt, [{ start: 0, end: 4, text: "default movie subtitle" }]);
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=red:s=320x240:r=24:d=5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-i", srt,
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-c:s", "srt",
        "-metadata:s:a:0", "language=eng",
        "-metadata:s:s:0", "language=eng",
        out,
      ], "movie.mkv");
    },
  },

  // 2. TV episode pair
  {
    name: "Show.S01E01.mkv",
    description: "5s episode, mirror of movie.mkv with TV-shaped filename.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-metadata:s:a:0", "language=eng",
        out,
      ], "Show.S01E01.mkv");
    },
  },
  {
    name: "Show.S01E02.mkv",
    description: "7s episode, distinguishable from S01E01 by duration.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=green:s=320x240:r=24:d=7",
        "-f", "lavfi", "-i", "sine=frequency=523:duration=7:sample_rate=48000",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-metadata:s:a:0", "language=eng",
        out,
      ], "Show.S01E02.mkv");
    },
  },

  // 3. Multi-audio
  {
    name: "multi-audio.mkv",
    description: "5s video + 3 audio tracks (EN/ES/FR) with language tags.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=yellow:s=320x240:r=24:d=5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-f", "lavfi", "-i", "sine=frequency=523:duration=5:sample_rate=48000",
        "-f", "lavfi", "-i", "sine=frequency=587:duration=5:sample_rate=48000",
        "-map", "0:v",
        "-map", "1:a", "-map", "2:a", "-map", "3:a",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-metadata:s:a:0", "language=eng",
        "-metadata:s:a:1", "language=spa",
        "-metadata:s:a:2", "language=fra",
        out,
      ], "multi-audio.mkv");
    },
  },

  // 4. Text subtitles (EN + FR)
  {
    name: "text-subtitles.mkv",
    description: "5s video + EN audio + 2 text subtitle tracks (EN, FR).",
    build(out) {
      const srtEn = join(OUT_DIR, "_tmp.text-subs.en.srt");
      const srtFr = join(OUT_DIR, "_tmp.text-subs.fr.srt");
      writeSrt(srtEn, [{ start: 0, end: 4, text: "Hello world" }]);
      writeSrt(srtFr, [{ start: 0, end: 4, text: "Bonjour le monde" }]);
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=cyan:s=320x240:r=24:d=5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-i", srtEn,
        "-i", srtFr,
        "-map", "0:v", "-map", "1:a", "-map", "2:s", "-map", "3:s",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-c:s", "srt",
        "-metadata:s:a:0", "language=eng",
        "-metadata:s:s:0", "language=eng",
        "-metadata:s:s:1", "language=fra",
        out,
      ], "text-subtitles.mkv");
    },
  },

  // 5. Image subtitles (PGS-style). lavfi cannot synthesize these directly.
  // Documented gap; placeholder is omitted (skipped) so existing-file checks
  // in e2e specs trip the @known-gap fixture-missing path consistently with
  // the existing convention.
  // (no-op recipe — see README)

  // 6. Undefined-language audio
  {
    name: "undefined-language.mkv",
    description: "5s video + audio track with NO language tag.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=magenta:s=320x240:r=24:d=5",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        // intentionally NO -metadata:s:a:0 language=...
        out,
      ], "undefined-language.mkv");
    },
  },

  // 7. No-audio
  {
    name: "no-audio.mkv",
    description: "5s video only, zero audio streams.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=white:s=320x240:r=24:d=5",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-an",
        out,
      ], "no-audio.mkv");
    },
  },

  // 8. Corrupt — start from movie.mkv, truncate to 50%.
  {
    name: "corrupt.mkv",
    description: "movie.mkv truncated to 50% of its byte length. Probe should fail.",
    build(out) {
      const src = join(OUT_DIR, "movie.mkv");
      if (!existsSync(src)) {
        throw new Error("corrupt.mkv depends on movie.mkv — recipe ordering broken");
      }
      copyFileSync(src, out);
      const fullSize = statSync(out).size;
      const halfSize = Math.floor(fullSize / 2);
      const fd = openSync(out, "r+");
      try {
        ftruncateSync(fd, halfSize);
      } finally {
        closeSync(fd);
      }
    },
  },

  // 9. Large — 60s 1080p; "large" relative to the corpus (still small file).
  {
    name: "large.mkv",
    description: "60s 1080p, exercises chunk-boundary code paths.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=gray:s=1920x1080:r=24:d=60",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=60:sample_rate=48000",
        "-c:v", "libx264", "-qp", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-metadata:s:a:0", "language=eng",
        out,
      ], "large.mkv");
    },
  },

  // 10. Tiny — 1s, exercises the "pack instead of chunk" path.
  {
    name: "tiny.mkv",
    description: "1s video, sub-chunk size, packs rather than chunks.",
    build(out) {
      runFfmpeg([
        "-f", "lavfi", "-i", "color=c=black:s=160x120:r=24:d=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
        "-c:v", "libx264", "-qp", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000",
        "-metadata:s:a:0", "language=eng",
        out,
      ], "tiny.mkv");
    },
  },
];

// ---------------------------------------------------------------------------
// SRT helper
// ---------------------------------------------------------------------------

function writeSrt(path: string, entries: { start: number; end: number; text: string }[]) {
  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  const body = entries
    .map((e, i) => `${i + 1}\n${fmt(e.start)} --> ${fmt(e.end)}\n${e.text}\n`)
    .join("\n");
  // node:fs writeFileSync via dynamic import to keep top imports tight
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(path, body);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  ensureOutDir();
  let built = 0;
  let skipped = 0;
  for (const recipe of recipes) {
    const outPath = join(OUT_DIR, recipe.name);
    if (shouldSkip(outPath)) {
      skipped += 1;
      continue;
    }
    process.stdout.write(`[v2-fixtures] building ${recipe.name} ... `);
    try {
      recipe.build(outPath);
      const size = statSync(outPath).size;
      process.stdout.write(`ok (${size} bytes)\n`);
      built += 1;
    } catch (e) {
      process.stdout.write(`FAILED\n`);
      throw e;
    }
  }
  // tidy temp srts
  for (const f of ["_tmp.movie.en.srt", "_tmp.text-subs.en.srt", "_tmp.text-subs.fr.srt"]) {
    const p = join(OUT_DIR, f);
    if (existsSync(p)) {
      try { require("node:fs").unlinkSync(p); } catch { /* ignore */ }
    }
  }
  process.stdout.write(`[v2-fixtures] done. built=${built} skipped=${skipped} (--force to rebuild)\n`);
}

main();
