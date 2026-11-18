import type { LifecycleState } from "@space/mpv-protocol";

import type { AudioOption } from "@/lib/playbackTypes";
import type { ChunkMap } from "@/lib/mpvPlaybackMaps";
import type { QualityPreset } from "@/lib/config";
import { pickSettingsFormat } from "@/lib/mpvPlaybackSelection";

/**
 * Lifecycle helpers — derive the active/ready predicates from the
 * LifecycleState snapshot. Replace the renderer's previous local
 * helpers in `useMpvPlaybackEngine.ts`; extracted in PR 4.1a so the
 * new `useExternalMpvCommands` facade can share them.
 *
 * active = mpv process is running (or about to be torn down). Mirrors
 * the previous semantics: `launching` counts as active because the
 * launch flow must not redirect to the "process gone" branch mid-spawn.
 */
export const isExternalActive = (lifecycle: LifecycleState): boolean =>
  lifecycle.kind !== "idle" && lifecycle.kind !== "stopping";

/**
 * True when there is an external mpv process the renderer can actually talk
 * to: the external player is enabled for this session AND the lifecycle is
 * not idle/stopping. Gate for every "pause / wait for pause" dance — with no
 * player there is nothing to pause, and the polling loops only sleep.
 *
 * @bugfix @regression-proof pause-for-change-idle-dead-wait
 */
export const hasLiveExternalPlayer = (
  lifecycle: LifecycleState,
  externalPlayerEnabled: boolean,
): boolean => externalPlayerEnabled && isExternalActive(lifecycle);

/**
 * ready = mpv's JSON IPC socket is up AND it has responded to a
 * `get_property time-pos` probe. The lifecycle state machine elevates
 * the session past "launching" only when the socket is ready, so any
 * state other than "idle" / "launching" / "stopping" implies readiness
 * for the engine's purposes.
 */
export const isExternalReady = (lifecycle: LifecycleState): boolean =>
  lifecycle.kind === "socket-ready" || lifecycle.kind === "playing";

/**
 * launch-start timestamp, derived. Returns 0 when not in a launch
 * state — matches the previous `externalLaunchStartedAtRef.current`
 * behavior (0 = no launch in progress).
 */
export const externalLaunchStartedAt = (lifecycle: LifecycleState): number =>
  lifecycle.kind === "launching" ? lifecycle.startedAt : 0;

type FormatLike = {
  id: string;
  quality: string;
  codec?: string | null;
  codecString?: string | null;
  initKey?: string | null;
  initSize?: number | null;
  durationSeconds?: number | null;
  totalSize?: number | null;
  chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>;
};

const toChunkMap = (
  initKey: string | null | undefined,
  initSize: number | null | undefined,
  durationSeconds: number | null | undefined,
  totalSize: number | null | undefined,
  chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>
): ChunkMap | null => {
  if (!initKey && chunks.length === 0) return null;
  return {
    init: initKey ? { key: initKey, size: initSize ?? 0 } : null,
    durationSeconds: durationSeconds ?? null,
    totalSize: totalSize ?? null,
    chunks: chunks.map((chunk) => ({
      key: chunk.key,
      size: chunk.sizeBytes ?? 0,
      startSeconds: chunk.startSeconds ?? null,
    })),
  };
};

export const buildPlaybackSignature = (
  id: string | null | undefined,
  codec: string | null | undefined,
  codecString: string | null | undefined,
  initKey: string | null | undefined,
  chunks: Array<{ key: string }>,
) => {
  if (!id) return "none";
  const firstChunk = chunks[0]?.key ?? "";
  const lastChunk = chunks[chunks.length - 1]?.key ?? "";
  return [id, codec ?? "", codecString ?? "", initKey ?? "", chunks.length, firstChunk, lastChunk].join("|");
};

/**
 * Whether the quality/audio reload effect may run. The video map is always
 * required; the audio map only when the media actually has a playable audio
 * track. Silent media (screen recordings, silent films) legitimately has none
 * and must still reload on a quality switch.
 */
export const isPlaybackReloadReady = (params: {
  effectiveFormatMap: ChunkMap | null;
  audioMap: ChunkMap | null;
  hasPlayableAudio: boolean;
}): boolean => {
  if (!params.effectiveFormatMap) return false;
  if (params.hasPlayableAudio && !params.audioMap) return false;
  return true;
};

export const buildMpvPlaybackState = <
  TFormat extends FormatLike,
  TAudio extends AudioOption,
>(
  params: {
    formats: TFormat[];
    playbackQuality: QualityPreset;
    selectedFormatId: string | null;
    qualityMode: "auto" | "fixed";
    audioOptions: TAudio[];
    selectedAudioId: string | null;
  }
) => {
  const { formats, playbackQuality, selectedFormatId, qualityMode, audioOptions, selectedAudioId } = params;
  // PLAY-QUAL-02: Settings rung, else the best below it, else the lightest above it (never the best of the ladder).
  const settingsFormat = pickSettingsFormat(formats, playbackQuality);
  const fallbackFormatId = settingsFormat?.id ?? null;
  const selectedFormat =
    formats.find((format) => format.id === (selectedFormatId ?? fallbackFormatId)) ?? null;
  const autoFormat = settingsFormat;
  const effectiveFormat = qualityMode === "auto" ? autoFormat : selectedFormat;
  const effectiveFormatId = effectiveFormat?.id ?? null;
  const effectiveFormatMap = effectiveFormat
    ? toChunkMap(
        effectiveFormat.initKey ?? null,
        effectiveFormat.initSize ?? null,
        effectiveFormat.durationSeconds ?? null,
        effectiveFormat.totalSize ?? null,
        effectiveFormat.chunks
      )
    : null;
  const effectiveFormatSignature = effectiveFormat
    ? buildPlaybackSignature(
        effectiveFormat.id,
        effectiveFormat.codec ?? null,
        effectiveFormat.codecString ?? null,
        effectiveFormat.initKey ?? null,
        effectiveFormat.chunks
      )
    : "none";

  const selectedAudio = audioOptions.find((option) => option.id === selectedAudioId) ?? null;
  const playableAudioOptions = audioOptions.filter((option) => Boolean(option.initKey && option.chunks?.length));
  const resolvedAudio =
    selectedAudio && selectedAudio.initKey && selectedAudio.chunks?.length
      ? selectedAudio
      : playableAudioOptions[0] ?? null;
  const audioMap =
    resolvedAudio && resolvedAudio.initKey && resolvedAudio.chunks?.length
      ? toChunkMap(
          resolvedAudio.initKey,
          resolvedAudio.initSize ?? null,
          resolvedAudio.durationSeconds ?? null,
          resolvedAudio.totalSize ?? null,
          resolvedAudio.chunks
        )
      : null;
  const audioMapSignature = audioMap
    ? [
        selectedAudio?.id ?? "",
        audioMap.init?.key ?? "",
        audioMap.chunks.length,
        audioMap.chunks[0]?.key ?? "",
        audioMap.chunks[audioMap.chunks.length - 1]?.key ?? "",
      ].join("|")
    : "none";

  return {
    fallbackFormatId,
    selectedFormat,
    autoFormat,
    effectiveFormat,
    effectiveFormatId,
    effectiveFormatMap,
    effectiveFormatSignature,
    selectedAudio,
    playableAudioOptions,
    audioMap,
    audioMapSignature,
    initSignature: [effectiveFormatSignature, audioMapSignature].join("|"),
  };
};
