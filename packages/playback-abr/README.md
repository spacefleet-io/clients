# @space/playback-abr

The auto-quality (ABR) policy shared by the desktop and mobile apps (Chris 2026-10-15: one package in v0). Pure TypeScript: no React, Electron or React Native imports, no I/O, no clocks (every function takes `nowMs`).

## API (`src/index.ts`)

| Area | Exports |
|---|---|
| Ladder | `QUALITY_ORDER`, `QualityPreset`, `QUALITY_HEIGHT_PX`, `Variant`, `qualityRank`, `isHevcCodec`, `isH264Codec`, `needsH264Fallback` (any non-H.264 original: HEVC, AV1, VP9 ... falls back to H.264), bitrate fallbacks |
| Start | `planStart`, `pickStartVariant`, `DecoderVerdicts`, `QualitySetting` |
| Cache | `CacheConfig { cacheSecs, demuxerMaxBytes }`, `reachableBufferSeconds`, `upshiftBufferThresholdS`, `healthyBufferFloorS` |
| Network | `abrDecide`, `AbrState`, `AbrDecision`, `blendBps`, `DOWNSHIFT_HOLD_*`, `MAX_CLIMB_HOLD_MS`, `SWITCH_COOLDOWN_MS` |
| Quality state | `createQualityState`, `selectQuality`, `applyAbrDecision`, `planHevcFallback`, `planH264DecodeFallback`, `planDecodeFallback` |
| Lag | `LagDetector`, `stepLagDetector`, `resetLagDetector` |
| Quality cap | `QualityCap` (`"480p" \| "1080p"`), `CapTarget`, `capCeilingRank`, `capTarget` (PLAY-QUAL-07: the cap a saturated silo reports; the server cannot see a resolution, so clients enforce it) |
| Controller | `createAbrController(variants, setting, nowMs, caps?, { firstFrameFrom: "vo" \| "event", netBpsIsSmoothed?, decoderPolicy? })`, `stepAbr` (decode check, then network), `stepDecoder` (the decode check alone: a lighter version, or `too-weak` once per file when nothing lighter is left or the rung is pinned; `null` when the device keeps up), `stepNetworkAbr` (network only; also returns the rate-limited `warn` for a pinned rung the link cannot sustain), `NetworkSample`, `AbrSample` (`decodeVariants?`), `AbrAction`, `PINNED_WARN_COOLDOWN_MS`, `pinnedNetworkWarning`, `cacheReachedEnd`, `noteLaunch` / `noteSessionStarted` / `noteLoadStarted` / `noteReloadStarted` / `noteSwitchSettled` / `noteFirstFrame` / `noteSeek` |

## Contract

- **No default cache config.** `CacheConfig` comes from each client: mobile 30 s / 32 MiB (`apps/badger/mobile/src/lib/playback/rungSwitch.ts`, pinned to `MpvSurfaceView.kt`), desktop 16 s / 96 MiB (`apps/badger/desktop/src/renderer/src/lib/abrCacheConfig.ts`, pinned to `packages/mpv/src/external.ts`). The upshift gate is derived from it, so it is always reachable.
- **No rung is banned by the network.** A downshift changes the current rung only; anti-flap is a capped climb hold. Only a decoder verdict limits rungs, for the file: an HEVC fallback bans every non-H.264 rung, and any decode step caps Auto at the lighter rung (`decodeCeilingRank`).
- **A pinned rung never switches** (`quality.mode === "manual"`).
- Mobile calls `stepAbr` (its own lag detector); desktop calls `stepDecoder(...) ?? stepNetworkAbr(...)` with a main-process link meter (`netBpsIsSmoothed: true`) and `decoderPolicy: "any"`, passing `decodeVariants` (its ladder rebuilt with the playing codec blocked) so an H.264 row hidden behind an HEVC row is reachable. Every option above is optional and defaults to the mobile behaviour.

## Tests

`bunx vitest run` here. Rule tests carry `@req` tags, simulations run for both clients' caches.

## Licence

GPL-3.0-only (`LICENSE`) with the App Store additional permission of GPL-3.0 section 7 (`LICENSE-EXCEPTION.md`), which covers only code held by the SpaceBadger authors (REL-LIC-01).
