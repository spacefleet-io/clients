import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { defaultCodecForQuality, QUALITY_ORDER, type CodecPreset, type QualityPreset, type SourceCodec } from "./quality";

export type JobStatus =
  | "waiting"
  | "identifying"
  | "needs_match"
  | "ready"
  | "transcoding"
  | "uploading"
  | "done"
  | "cancelled"
  | "failed";

export type LabJob = {
  id: string;
  filename: string;
  queueSequence?: number;
  status: JobStatus;
  progress: number;
  uploadSpeedMbps?: number;
  /**
   * Optional human-readable label for the current step's micro-stage (e.g.
   * "Extracting", "Uploading", "Committing"). Surfaced by the V2 ingest
   * pipeline only; legacy V1 records leave this undefined.
   */
  stageLabel?: string;
  /**
   * 1-based place in the runtime's queue while the job waits (status
   * "waiting"): new, or between two steps waiting for a lane slot (#2499).
   */
  queuePosition?: number;
  completedAt?: string;
  sourceQuality?: string;
  groupId?: string;
  jobType?: "source" | "transcode" | "download" | "export";
  includeSource?: boolean;
  includeFallback?: boolean;
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackIndexes?: number[];
  subtitleTrackIndexes?: number[];
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  pendingKey?: string;
  pendingDetails?: {
    seasons: { id: string; seasonNumber: number; name: string | null }[];
    episodes: { id: string; seasonNumber: number; episodeNumber: number; name: string | null }[];
  };
  sizeMb?: number;
  videoMeta?: {
    width: number;
    height: number;
    durationSec: number;
    codec: SourceCodec;
  } | null;
  audioLangs?: { code: string; keep: boolean }[];
  subtitleLangs?: { code: string; keep: boolean }[];
  encoder?: "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" | "cpu";
  logs?: string[];
  selectedFormats?: { quality: string; codec: string }[];
  expanded?: boolean;
  manualQuery?: string;
  manualSelectedId?: string;
  manualSeason?: number;
  manualEpisode?: number;
  detectedTitle?: string;
  detectedYear?: string;
  detectedSeason?: number;
  detectedEpisode?: number;
  matchedMediaId?: string;
  matchedTo?: Pick<MediaRow, "title" | "year" | "posterPath" | "type">;
  linked?: boolean;
  fileId?: string;
  formatsCreated?: boolean;
  tracksAdded?: boolean;
  createdAt: string;
  error?: string;
  produced?: {
    videoFormats: Array<{
      quality: string;
      codec: string;
      codecString?: string | null;
      initKey: string;
      initSize: number;
      durationSeconds: number | null;
      totalSize: number;
      chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
      chapters?: Array<{ title: string; startSeconds: number }>;
    }>;
    audioTracks: Array<{
      language: string;
      label: string;
      codec: string | null;
      codecString?: string | null;
      initKey: string;
      initSize: number;
      durationSeconds: number | null;
      totalSize: number;
      chunks: Array<{ key: string; sizeBytes: number; startSeconds?: number | null }>;
      isDefault?: boolean;
    }>;
    subtitleTracks: Array<{
      language: string;
      label: string;
      objectKey: string;
      format: string | null;
      isDefault?: boolean;
    }>;
  };
};

export type QueuePreset = {
  media?: MediaRow;
  season?: number;
  episode?: number;
  pendingKey?: string;
  pendingMedia?: Pick<
    MediaRow,
    "id" | "type" | "catalogId" | "title" | "year" | "posterPath" | "originalLanguage"
  >;
  pendingDetails?: LabJob["pendingDetails"];
};

export type TranscodeOutput = { quality: QualityPreset; codec: CodecPreset };

export type LabQueueConfig = {
  enableCodecSelection: boolean;
  transcodeOutputs: Array<{ quality: string; codec: string }>;
  maxParallelTranscodes?: number;
  uiLanguage: string;
  token?: string | null;
  libraryKeyBase64?: string | null;
};

export type LabQueueFileInput = {
  id: string;
  filename: string;
  sizeMb: number | null;
  sourceQuality?: string;
  videoMeta?: LabJob["videoMeta"] | null;
  groupId?: string;
  jobType?: "source" | "transcode" | "download" | "export";
  includeSource?: boolean;
  includeFallback?: boolean;
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
  audioTrackIndexes?: number[];
  subtitleTrackIndexes?: number[];
  audioTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  subtitleTrackOverrides?: Array<{ index: number; language: string; label: string }>;
  selectedFormats?: Array<{ quality: string; codec: string }>;
};

export type LabQueueFormatJobInput = {
  id: string;
  mediaId: string;
  fileId: string;
  filename: string;
  season?: number | null;
  episode?: number | null;
  formats: Array<{ quality: string; codec: string }>;
};

export type LabQueueAction =
  | { type: "queue_files"; files: LabQueueFileInput[]; preset?: QueuePreset | null }
  | { type: "queue_format_jobs"; jobs: LabQueueFormatJobInput[] }
  | { type: "attach_pending_media"; pendingKey: string; mediaId: string }
  | { type: "remove_media_jobs"; mediaId: string }
  | { type: "start_job"; jobId: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "toggle_job_format"; jobId: string; quality: string; codec: string; enabled: boolean }
  | { type: "toggle_job_track"; jobId: string; trackType: "audio" | "subtitle"; code: string; keep: boolean }
  | { type: "remove_job"; jobId: string }
  | { type: "toggle_expanded"; jobId: string }
  | { type: "set_manual_query"; jobId: string; value: string }
  | { type: "set_manual_selection"; jobId: string; mediaId: string }
  | { type: "set_manual_season"; jobId: string; season: number }
  | { type: "set_manual_episode"; jobId: string; episode: number }
  | { type: "clear_match"; jobId: string }
  | { type: "clear_completed" }
  | { type: "update_job_meta"; jobId: string; videoMeta: LabJob["videoMeta"] | null };

/**
 * No quality is built by default: the one 360p fallback copy is a per-computer
 * choice (desktop `device-settings.json`), not part of the account ladder.
 */
export const DEFAULT_TRANSCODE_OUTPUTS: TranscodeOutput[] = [];

const normalizeTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const titleScore = (a: string, b: string) => {
  const aNorm = normalizeTitle(a);
  const bNorm = normalizeTitle(b);

  if (aNorm === bNorm) return 1;

  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.85;

  const aTokens = new Set(aNorm.split(" ").filter(Boolean));
  const bTokens = new Set(bNorm.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export const pickBestMatch = (
  parsed: { title: string; year?: string; season?: number; episode?: number },
  candidates: MediaRow[]
) => {
  const wantsTv = typeof parsed.season === "number" && typeof parsed.episode === "number";
  const filtered = wantsTv ? candidates.filter((c) => c.type === "tv") : candidates;

  let best: { item: MediaRow; score: number } | null = null;
  for (const item of filtered) {
    let score = titleScore(parsed.title, item.title);
    if (item.originalTitle) {
      const origScore = titleScore(parsed.title, item.originalTitle);
      score = Math.max(score, origScore);
    }
    if (parsed.year && item.year && parsed.year === item.year) score += 0.15;
    if (wantsTv && item.type === "tv") score += 0.05;
    if (!best || score > best.score) best = { item, score };
  }

  if (!best) return null;
  if (best.score < 0.4) return null;
  return best.item;
};

export const qualityRank = (quality: string) => {
  const idx = QUALITY_ORDER.indexOf(quality as QualityPreset);
  return idx === -1 ? QUALITY_ORDER.length : idx;
};

export const estimateSizeMb = (quality: string, codec: string, mediaType: "movie" | "tv") => {
  const base = {
    "2160p": { h264: 9000, hevc: 6000 },
    "1080p": { h264: 2800, hevc: 1700 },
    "720p": { h264: 1600, hevc: 1000 },
    "480p": { h264: 800, hevc: 550 },
    "360p": { h264: 520, hevc: 360 },
    "240p": { h264: 320, hevc: 220 },
    "144p": { h264: 180, hevc: 130 },
    source: { h264: 3200, hevc: 2200 },
  } as const;
  const preset = base[quality as keyof typeof base] ?? base["1080p"];
  const size = codec === "hevc" ? preset.hevc : preset.h264;
  return mediaType === "tv" ? Math.round(size * 0.35) : size;
};

export const estimateBitrateKbps = (quality: string, codec: string) => {
  const base = {
    "2160p": 12000,
    "1080p": 5000,
    "720p": 2500,
    "480p": 1200,
    "360p": 800,
    "240p": 500,
    "144p": 300,
  } as const;
  const fallback = base["1080p"];
  const target = base[quality as keyof typeof base] ?? fallback;
  return codec === "hevc" ? Math.round(target * 0.7) : target;
};

export const estimateFromFile = (
  baseSizeMb: number | undefined,
  quality: string,
  codec: string,
  mediaType: "movie" | "tv"
) => {
  if (!baseSizeMb || !Number.isFinite(baseSizeMb)) {
    return estimateSizeMb(quality, codec, mediaType);
  }
  const ratios: Record<string, number> = {
    "2160p": 1,
    "1080p": 0.7,
    "720p": 0.5,
    "480p": 0.32,
    "360p": 0.22,
    "240p": 0.16,
    "144p": 0.1,
  };
  const baseRatio = ratios[quality] ?? 0.7;
  const codecFactor = codec === "hevc" ? 0.7 : 1;
  const size = Math.max(8, Math.round(baseSizeMb * baseRatio * codecFactor));
  return mediaType === "tv" ? Math.round(size * 0.85) : size;
};

// Approximate pixel count per quality preset, used by the pixel-ratio
// estimator below. Numbers match the canonical 16:9 frames produced by
// our transcoder (mediaProcessor.qualityHeight × 16/9 width).
const QUALITY_PIXELS_FOR_ESTIMATE: Record<string, number> = {
  "2160p": 3840 * 2160,
  "1080p": 1920 * 1080,
  "720p": 1280 * 720,
  "480p": 854 * 480,
  "360p": 640 * 360,
  "240p": 427 * 240,
  "144p": 256 * 144,
};

// Floor for AAC stereo re-encodes — we assume the output audio track is
// re-encoded around this bitrate regardless of source audio bitrate.
// Low-resolution targets are dominated by this fixed cost, which is
// exactly why the pure ratio estimator overshoots at 240p/144p.
const ASSUMED_AUDIO_KBPS = 96;

/**
 * Source-aware estimator for "add this quality" / "produce this transcode"
 * UIs. Scales the source's video bitrate by the pixel ratio (target /
 * source), keeps the audio cost constant, and caps the video bitrate by
 * the static `estimateBitrateKbps` ceiling so high-bitrate disc remuxes
 * don't blow past the "good quality" target for low resolutions.
 *
 * Returns null when prerequisites are missing — caller MUST fall back to
 * `estimateFromFile` (file-size ratio) or `estimateSizeMb` (static
 * bitrate × duration). This matches what AddQualityModal does today.
 *
 * Why this exists separate from `estimateFromFile`:
 *   - the legacy ratio approach scales the FULL source bitrate (video +
 *     audio) by a single per-quality factor. For a 2.6 Mbps 1080p source
 *     of a 150-min movie, the 360p estimate is ~638 MB even though
 *     ~141 MB of that is fixed audio cost — the gap between 360p and
 *     240p compresses to ~150 MB.
 *   - the pixel-ratio model treats audio as a fixed line item and lets
 *     low-resolution video estimates fall realistically toward zero. The
 *     same HP source produces 360p ≈ 416 MB, 240p ≈ 244 MB — friendlier
 *     numbers AND a sensible gap.
 */
export const estimateFromSourceFormat = (params: {
  sourceSizeMb: number | null | undefined;
  sourceQuality: string | null | undefined;
  targetQuality: string;
  targetCodec: string;
  durationSeconds: number | null | undefined;
  mediaType: "movie" | "tv";
}): number | null => {
  const {
    sourceSizeMb,
    sourceQuality,
    targetQuality,
    targetCodec,
    durationSeconds,
    mediaType,
  } = params;
  if (!sourceSizeMb || !Number.isFinite(sourceSizeMb) || sourceSizeMb <= 0) return null;
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const sourcePixels = sourceQuality
    ? QUALITY_PIXELS_FOR_ESTIMATE[sourceQuality]
    : undefined;
  const targetPixels = QUALITY_PIXELS_FOR_ESTIMATE[targetQuality];
  if (!sourcePixels || !targetPixels) return null;
  if (targetPixels >= sourcePixels) return null;

  // Source total bitrate (kbps). Convert MB→kbits via *8*1024 then divide
  // by seconds.
  const sourceTotalKbps = (sourceSizeMb * 8 * 1024) / durationSeconds;
  // Subtract the assumed audio cost to isolate the video bitrate. Floor at
  // 50 kbps to avoid pathological estimates from impossibly small sources.
  const sourceVideoKbps = Math.max(50, sourceTotalKbps - ASSUMED_AUDIO_KBPS);

  // Linear pixel scaling. The slightly-better compression efficiency of
  // smaller frames is roughly offset by the relatively higher overhead of
  // motion-vector and slice headers at low bitrates — linear is a fair
  // approximation across the range we care about.
  const targetVideoKbps = sourceVideoKbps * (targetPixels / sourcePixels);
  // HEVC saves ~30% over h264 at the same perceptual quality.
  const codecAdjusted = targetCodec === "hevc" ? targetVideoKbps * 0.7 : targetVideoKbps;
  // Cap by the "good quality" target — no point estimating a higher
  // bitrate than a fresh well-tuned encode at this resolution would use.
  const staticCapKbps = estimateBitrateKbps(targetQuality, targetCodec);
  const finalVideoKbps = Math.min(codecAdjusted, staticCapKbps);

  const totalKbps = finalVideoKbps + ASSUMED_AUDIO_KBPS;
  const sizeMb = Math.max(8, Math.round((totalKbps * durationSeconds) / 8 / 1024));
  return mediaType === "tv" ? Math.round(sizeMb * 0.85) : sizeMb;
};

export const expandOutputs = (outputs: { quality: string; codec: string }[], enableCodecSelection: boolean) => {
  const list: { quality: string; codec: string }[] = [];
  const seen = new Set<string>();

  if (!enableCodecSelection) {
    const dedup = new Set<string>();
    outputs.forEach((output) => {
      if (!output?.quality) return;
      if (dedup.has(output.quality)) return;
      dedup.add(output.quality);
      const entry = { quality: output.quality, codec: defaultCodecForQuality(output.quality as QualityPreset) };
      const key = `${entry.quality}:${entry.codec}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(entry);
    });
    return list;
  }

  outputs.forEach((output) => {
    if (!output?.quality) return;
    if (output.quality === "2160p") {
      const entry = { quality: output.quality, codec: "hevc" };
      const key = `${entry.quality}:${entry.codec}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(entry);
      return;
    }
    const entry = { quality: output.quality, codec: output.codec };
    const key = `${entry.quality}:${entry.codec}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(entry);
  });
  return list;
};

export const resolveTranscodeOutputs = (
  outputs: { quality: string; codec: string }[],
  enableCodecSelection: boolean,
  fallbackOutputs: { quality: string; codec: string }[] = []
) => {
  const expanded = expandOutputs(outputs, enableCodecSelection);
  if (expanded.length > 0) return expanded;
  return expandOutputs(fallbackOutputs, enableCodecSelection);
};

export const buildStorageOutputs = (
  enableCodecSelection: boolean
): Array<{ quality: QualityPreset; codec: CodecPreset }> => {
  if (!enableCodecSelection) {
    return QUALITY_ORDER.map((quality) => ({
      quality,
      codec: defaultCodecForQuality(quality),
    }));
  }

  return QUALITY_ORDER.flatMap<{ quality: QualityPreset; codec: CodecPreset }>((quality) => {
    if (quality === "2160p") return [{ quality, codec: "hevc" }];
    return [
      { quality, codec: "h264" },
      { quality, codec: "hevc" },
    ];
  });
};

export const generateChunkKeys = (sizeMb: number) => {
  const count = Math.max(4, Math.min(18, Math.round(sizeMb / 120)));
  return Array.from({ length: count }, () => crypto.randomUUID());
};

export const guessQualityLabel = (height: number, width?: number) => {
  const hasWidth = typeof width === "number" && Number.isFinite(width);
  const w = hasWidth ? width! : null;
  if (height >= 2160 || (w !== null && w >= 3000 && height >= 1600)) return "2160p";
  if (height >= 1080 || (w !== null && w >= 1600 && height >= 700)) return "1080p";
  if (height >= 720 || (w !== null && w >= 1200 && height >= 600)) return "720p";
  if (height >= 480 || (w !== null && w >= 850 && height >= 400)) return "480p";
  if (height >= 360 || (w !== null && w >= 620 && height >= 320)) return "360p";
  if (height >= 240 || (w !== null && w >= 420 && height >= 200)) return "240p";
  return "144p";
};

const ALL_FORMATS: { quality: QualityPreset; codec: "h264" | "hevc" }[] = [
  { quality: "2160p", codec: "hevc" },
  { quality: "1080p", codec: "hevc" },
  { quality: "1080p", codec: "h264" },
  { quality: "720p", codec: "hevc" },
  { quality: "720p", codec: "h264" },
  { quality: "480p", codec: "hevc" },
  { quality: "480p", codec: "h264" },
  { quality: "360p", codec: "hevc" },
  { quality: "360p", codec: "h264" },
  { quality: "240p", codec: "hevc" },
  { quality: "240p", codec: "h264" },
  { quality: "144p", codec: "hevc" },
  { quality: "144p", codec: "h264" },
];

export const getAvailableFormats = (
  sourceQuality: string | null,
  sourceCodec: SourceCodec | undefined,
  enableCodecSelection: boolean
): { quality: QualityPreset; codec: "h264" | "hevc"; isSource: boolean }[] => {
  const supportedFormats = enableCodecSelection
    ? ALL_FORMATS
    : ALL_FORMATS.filter((format) => format.codec === defaultCodecForQuality(format.quality));

  if (!sourceQuality) {
    return supportedFormats
      .filter((f) => f.quality !== "2160p")
      .map((f) => ({ ...f, isSource: false }));
  }

  const sourceRank = qualityRank(sourceQuality);
  const available: { quality: QualityPreset; codec: "h264" | "hevc"; isSource: boolean }[] = [];

  for (const format of supportedFormats) {
    const targetRank = qualityRank(format.quality);

    if (sourceRank >= 0 && targetRank >= 0 && targetRank < sourceRank) {
      continue;
    }

    const isSource =
      format.quality === sourceQuality &&
      sourceCodec !== "unknown" &&
      format.codec === sourceCodec;

    available.push({ ...format, isSource });
  }

  return available;
};

const normalizeLang = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "en";
};

export const buildTracks = (originalLanguage?: string | null, uiLanguage?: string) => {
  const base = normalizeLang(originalLanguage ?? uiLanguage ?? "en");
  const ui = normalizeLang(uiLanguage ?? "en");
  const audioLangs = [{ code: base, keep: true }];
  const subtitleLangs = [{ code: base, keep: true }];
  if (ui !== base) {
    subtitleLangs.push({ code: ui, keep: true });
  }
  return { audioLangs, subtitleLangs };
};

export const fileLabel = (media: MediaDetails, file: { season: number | null; episode: number | null }) => {
  if (media.type === "movie") return media.title;
  const season = typeof file.season === "number" ? String(file.season).padStart(2, "0") : "--";
  const episode = typeof file.episode === "number" ? String(file.episode).padStart(2, "0") : "--";
  return `${media.title} · S${season}E${episode}`;
};

export const formatJobOutputLabel = (quality: string, codec: string, showCodec: boolean) =>
  showCodec ? `${quality} ${codec.toUpperCase()}` : quality;
