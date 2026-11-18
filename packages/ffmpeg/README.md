# FFmpeg package

Runtime helpers around the ffmpeg / ffprobe binaries (`runFfmpeg` and friends in `src/index.ts`, the host-CPU and background-encode resource policy in `src/hostCpu.ts` / `src/resourcePolicy.ts`).

The binaries themselves are NOT built or vendored here. They ship in the per-OS `packages/media-deps` bundle (ffmpeg + ffprobe + mpv + libraries in one flat `bin/`, one reduced ffmpeg 8.1.3 build for all three):

```bash
bun run setup:binaries                          # repo root; = bun scripts/fetch-deps.ts, host target
bun scripts/fetch-deps.ts --target windows-x64  # another target
```

This fills `vendor/deps/<os>-<arch>/{bin,deps-manifest.json}` (packaged apps: `<resources>/deps/`). Resolution of the binary paths goes through the platform layer (`packages/desktop-platform-*` `binaries`), with `SF_FFMPEG_PATH` / `SF_FFPROBE_PATH` as explicit overrides.

The feature list (which encoders, muxers, demuxers, filters ship), the build recipes and how to add an OS are in `packages/media-deps/README.md`; the ffmpeg component pins that used to live here (`cpu-min` subtitle muxers, `playback-shared-min` bitmap-subtitle components) are in `packages/media-deps/tests/features.test.ts`. The retired profiles (`upstream` BtbN tarball, `cpu-min`, `playback-shared-min`) and their Docker scripts no longer exist.

Tests: `bun --cwd packages/ffmpeg run test`.
