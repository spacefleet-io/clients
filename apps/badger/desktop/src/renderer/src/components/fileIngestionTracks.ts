import { normalizeSourceCodec, type SourceCodec } from "../../../shared/quality";
import { guessQualityLabel, qualityRank } from "@/lib/labJobs";

export type FileIngestionTrackKey = {
  key: string;
  label: string;
  language: string;
};

export type FileIngestionTrackRef = {
  candidateId: string;
  index: number;
};

export type FileIngestionTrackGroup = FileIngestionTrackKey & {
  refs: FileIngestionTrackRef[];
};

export type FileIngestionVideoVariant<TCandidate> = {
  candidate: TCandidate;
  quality: string;
  codec: string;
  hasChapters: boolean;
};

type TrackLike = { language?: string | null; label?: string | null };

type CandidateLike = {
  id: string;
  kind: "video" | "subtitle";
  subtitleDraft?: { language: string; label: string };
  probe?: {
    video: { codec: string | null; width: number | null; height: number | null } | null;
    chapters: { count: number };
    audioTracks: Array<{ index: number; language: string; label: string; codec: string | null; channels: number | null }>;
    subtitleTracks: Array<{ index: number; language: string; label: string; codec: string | null }>;
  } | null;
};

export const normalizeFileIngestionLanguageCode = (raw?: string | null) => {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "und";
  if (value === "eng") return "en";
  if (value === "fre" || value === "fra") return "fr";
  if (value === "spa") return "es";
  if (value === "por") return "pt";
  if (value === "ger" || value === "deu") return "de";
  if (value === "ita") return "it";
  if (value === "jpn") return "ja";
  if (value === "kor") return "ko";
  if (value === "chi" || value === "zho") return "zh";
  return value.length === 2 ? value : "und";
};

export const isUndefinedLikeTrackLabel = (label?: string | null) => {
  const normalized = (label ?? "").trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "und" ||
    normalized === "undefined" ||
    normalized === "indéfini" ||
    normalized === "indefini" ||
    normalized === "non identifiée" ||
    normalized === "non identifiee"
  );
};

export const trackNeedsLanguageReview = (track: TrackLike) => {
  const hasExplicitName = !isUndefinedLikeTrackLabel(track.label);
  if (hasExplicitName) {
    return false;
  }
  const language = normalizeFileIngestionLanguageCode(track.language);
  return language === "und";
};

export type FileIngestionTrackSelection = { audio: Set<string>; subtitles: Set<string> };

/**
 * The tracks a group or episode slot imports, from its current tracks. A slot the user has not edited takes every
 * track; an edited slot keeps its stored choice plus any track it had not seen yet (a probe that landed later). Render
 * and the seeding effect both call this, so a late probe's tracks count from the render that shows them.
 */
export const resolveFileIngestionTrackSelection = (
  current: { audio: readonly string[]; subtitles: readonly string[] },
  stored: FileIngestionTrackSelection | undefined,
  known: FileIngestionTrackSelection | undefined,
  touched: boolean
): FileIngestionTrackSelection => {
  if (!stored || !touched) {
    return { audio: new Set(current.audio), subtitles: new Set(current.subtitles) };
  }
  const audio = new Set(stored.audio);
  const subtitles = new Set(stored.subtitles);
  current.audio.forEach((key) => {
    if (!known?.audio.has(key)) audio.add(key);
  });
  current.subtitles.forEach((key) => {
    if (!known?.subtitles.has(key)) subtitles.add(key);
  });
  return { audio, subtitles };
};

/** The source video's real codec label (hevc, h264, av1, vp9 ... or the raw ffprobe name; "unknown" without one). */
export const normalizeVideoCodec = (value?: string | null): SourceCodec => normalizeSourceCodec(value);

export const preferHevcForQuality = (quality: string) => qualityRank(quality) >= qualityRank("1080p");

export const pickPreferredCodec = (quality: string, codecs: string[]) => {
  if (codecs.length <= 1) return codecs[0] ?? "unknown";
  const preferHevc = preferHevcForQuality(quality);
  if (preferHevc && codecs.includes("hevc")) return "hevc";
  if (!preferHevc && codecs.includes("h264")) return "h264";
  return codecs[0] ?? "unknown";
};

export const buildSelectedVideoVariants = <TCandidate>(
  variants: Array<FileIngestionVideoVariant<TCandidate>>,
  enableCodecSelection: boolean
) => {
  const byQuality = new Map<string, Array<FileIngestionVideoVariant<TCandidate>>>();
  variants.forEach((entry) => {
    const list = byQuality.get(entry.quality) ?? [];
    list.push(entry);
    byQuality.set(entry.quality, list);
  });

  const selected: Array<FileIngestionVideoVariant<TCandidate>> = [];
  byQuality.forEach((list, quality) => {
    if (quality === "unknown") {
      selected.push(...list);
      return;
    }
    const codecs = Array.from(new Set(list.map((item) => item.codec)));
    if (enableCodecSelection && codecs.length > 1) {
      selected.push(...list);
      return;
    }
    const preferred = pickPreferredCodec(quality, codecs);
    const winner = list.find((item) => item.codec === preferred) ?? list[0];
    if (winner) selected.push(winner);
  });
  return selected;
};

export const buildTrackSummary = <TCandidate extends CandidateLike>(
  groupCandidates: TCandidate[],
  languageLabel: (code?: string | null) => string
) => {
  const audioMap = new Map<
    string,
    { label: string; language: string; refs: FileIngestionTrackRef[] }
  >();
  const subtitleMap = new Map<
    string,
    { label: string; language: string; refs: FileIngestionTrackRef[] }
  >();
  const videoVariants: Array<FileIngestionVideoVariant<TCandidate>> = [];

  groupCandidates.forEach((candidate) => {
    if (candidate.kind === "subtitle") {
      const language = normalizeFileIngestionLanguageCode(candidate.subtitleDraft?.language);
      const label = candidate.subtitleDraft?.label?.trim() || languageLabel(language);
      const keyTrack = trackNeedsLanguageReview({ language, label })
        ? `${language}:${label}:external:${candidate.id}:0`
        : `${language}:${label}:external`;
      const entry = subtitleMap.get(keyTrack) ?? { label, language, refs: [] };
      entry.refs.push({ candidateId: candidate.id, index: 0 });
      subtitleMap.set(keyTrack, entry);
      return;
    }
    if (candidate.kind !== "video") return;
    const probe = candidate.probe;
    if (probe?.audioTracks?.length) {
      probe.audioTracks.forEach((track) => {
        const keyTrack = trackNeedsLanguageReview(track)
          ? `${track.language}:${track.label}:${track.codec ?? "unknown"}:${track.channels ?? "0"}:${candidate.id}:${track.index}`
          : `${track.language}:${track.label}:${track.codec ?? "unknown"}:${track.channels ?? "0"}`;
        const entry = audioMap.get(keyTrack) ?? { label: track.label, language: track.language, refs: [] };
        entry.refs.push({ candidateId: candidate.id, index: track.index });
        audioMap.set(keyTrack, entry);
      });
    }
    if (probe?.subtitleTracks?.length) {
      probe.subtitleTracks.forEach((track) => {
        const keyTrack = trackNeedsLanguageReview(track)
          ? `${track.language}:${track.label}:${track.codec ?? "unknown"}:${candidate.id}:${track.index}`
          : `${track.language}:${track.label}:${track.codec ?? "unknown"}`;
        const entry = subtitleMap.get(keyTrack) ?? { label: track.label, language: track.language, refs: [] };
        entry.refs.push({ candidateId: candidate.id, index: track.index });
        subtitleMap.set(keyTrack, entry);
      });
    }
    const video = probe?.video;
    const quality = video?.height ? guessQualityLabel(video.height, video.width ?? undefined) : "unknown";
    const codec = normalizeVideoCodec(video?.codec ?? null);
    const hasChapters = (probe?.chapters?.count ?? 0) > 0;
    videoVariants.push({ candidate, quality, codec, hasChapters });
  });

  return {
    audioTracks: Array.from(audioMap.entries()).map(([keyTrack, entry]) => ({
      key: keyTrack,
      label: entry.label,
      language: entry.language,
      refs: entry.refs,
    })),
    subtitleTracks: Array.from(subtitleMap.entries()).map(([keyTrack, entry]) => ({
      key: keyTrack,
      label: entry.label,
      language: entry.language,
      refs: entry.refs,
    })),
    videoVariants,
  };
};
