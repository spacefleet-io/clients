# MPV Package

We only support the external mpv OSC path; embedded/native players are not used.


## Purpose

This package provides:
- OSC resources and icons (`resources/`),
- shared path resolution and launch helpers for external playback (`src/external.ts`).

The mpv binary is NOT built or vendored here. It ships in the per-OS `packages/media-deps` bundle (mpv + ffmpeg + ffprobe + libraries in one flat `bin/`, one shared ffmpeg 8.1.3 build): fetch it with `bun run setup:binaries` (= `bun scripts/fetch-deps.ts`), which fills `vendor/deps/<os>-<arch>/`. Packaged apps carry it as `<resources>/deps/`. The feature list, the Linux and Windows recipes and the "Adding a system" guide are in `packages/media-deps/README.md`.

Desktop launches external mpv with the SpaceFleet OSC (`resources/osc/sf.lua`) only by default. The older extra
`tog4in1` OSC/window-controls script layer is still available for debugging via
`SF_MPV_ENABLE_TOG4IN1=1`, but it is no longer part of the default playback stack.

## What the shipped mpv guarantees

Each point is pinned by `packages/media-deps/tests/features.test.ts` (feature list) and the bundle verify step (real binary):
- **glibc**: the Linux bundle never ships glibc; it is built on Ubuntu 22.04. **Minimum host glibc: 2.35.** RUNPATH is `$ORIGIN`, so the bundle runs from any directory, as root too.
- **zimg**: when mpv falls back to CPU rendering (`--vo=x11`: no GPU context, software GL only, or `SF_MPV_EXTERNAL_VO=x11`), every frame is converted and scaled on the CPU; without zimg mpv uses libswscale (about twice the CPU per 1080p frame, #25 N3). The build enables zimg and the verify step checks `mpv -v --version`.
- **astats**: the ultimate suite's audio-signal check adds a `lavfi=[astats=...]` filter (`e2e-ultimate/lib/oscChecks.ts` `readTone`); the shared ffmpeg feature list carries it.
- **Image + bitmap subtitle decoders**: `mjpeg`, `png`, `webp` + `image2`/`*_pipe` for the play-time backdrop still, and `pgssub`/`dvdsub` plus the `sup`/`matroska` demuxers for bitmap subtitles.

### Bundle fontconfig

The bundle carries its own fontconfig (2.13, `cache-7`), which cannot read a newer host's font caches
(e.g. 2.18, `cache-11`). Its first OSD setup therefore scans every host font before mpv's first frame:
a black window for 1.8 s on an idle host, 8-17 s under load. At app start the desktop main process runs
the bundle once headless (`planMpvBundleFontCacheWarmup`: `--vo=null --ao=null --frames=1` on a 1x1
PNG, priority 19), which writes the bundle's cache next to the host's; a play then sets up fonts in
milliseconds (backdrop first frame ~50 ms). The bundle keeps the host's full font set, so text
subtitles in any script keep their glyphs. An operator-pinned system mpv (`SF_MPV_SYSTEM_BIN`) skips the warm-up.

## Scripts

Run these from the repo root.

- Fetch the binaries (host target; cached by version + sha256, offline when cached):
  - `bun run setup:binaries`
  - `bun scripts/fetch-deps.ts --target windows-x64` for another target
- Building the bundle is `packages/media-deps` (build recipes and tooling in that package).
- Tests: `bun --cwd packages/mpv run test`
