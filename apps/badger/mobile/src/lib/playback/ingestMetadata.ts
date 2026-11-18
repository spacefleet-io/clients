import type {
  IngestMetadata,
  AudioTrack as PlayerAudioTrack,
  SubtitleTrack as PlayerSubtitleTrack,
  VideoFormat as PlayerVideoFormat,
} from "@space/mobile-mpv-playback";
import { isOcrTwin, ocrTwinsByPictureId } from "@space/shared/subtitleTwins";

const VOBSUB_FORMATS = ["vobsub", "dvd_subtitle", "dvb_subtitle", "matroska", "mkv"];
const PGS_FORMATS = ["pgs", "sup", "hdmv"];

/** Map a stored subtitle row (format + object key) to a player subtitle format. */
export const resolveSubtitleFormat = (
  format: string | null | undefined,
  objectKey: string | null | undefined
): PlayerSubtitleTrack["format"] => {
  const value = (format ?? "").toLowerCase();
  if (value === "sub" || VOBSUB_FORMATS.some((f) => value.includes(f))) return "vobsub";
  if (PGS_FORMATS.some((f) => value.includes(f))) return "pgs";
  if (value) return "vtt";
  const key = (objectKey ?? "").toLowerCase();
  if (key.endsWith(".mkv") || key.endsWith(".sub") || key.endsWith(".idx")) return "vobsub";
  if (key.endsWith(".sup")) return "pgs";
  return "vtt";
};

export const buildIngestMetadata = (input: {
  formats: Array<{
    id: string;
    quality: string;
    codec: string;
    codecString?: string | null;
    bitrateKbps?: number | null;
    initKey: string | null;
    initSize: number | null;
    durationSeconds: number | null;
    totalSize: number | null;
    chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
  }>;
  audioTracks: Array<{
    id: string;
    language: string;
    label: string;
    isDefault: boolean;
    codec: string | null;
    codecString?: string | null;
    initKey: string | null;
    initSize: number | null;
    durationSeconds: number | null;
    totalSize: number | null;
    chunks: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
  }>;
  subtitleTracks: Array<{
    id: string;
    language: string;
    label: string;
    isDefault: boolean;
    format: string | null;
    objectKey: string | null;
    source?: string | null;
    derivedFromSubtitleId?: string | null;
  }>;
  chapters: Array<{ title: string; startSeconds: number }>;
  durationSeconds: number;
}): IngestMetadata => {
  const videos: PlayerVideoFormat[] = input.formats
    .filter((f) => f.initKey && f.chunks.length > 0)
    .map((f) => ({
      id: f.id,
      quality: f.quality,
      codec: f.codec,
      codecString: f.codecString ?? "",
      initKey: f.initKey ?? "",
      initSize: f.initSize ?? 0,
      durationSeconds: f.durationSeconds ?? 0,
      totalSize: f.totalSize ?? 0,
      bitrateKbps: f.bitrateKbps ?? undefined,
      chunks: f.chunks.map((c) => ({
        key: c.key,
        sizeBytes: c.sizeBytes ?? 0,
        startSeconds: c.startSeconds ?? 0,
      })),
    }));

  const audioTracks: PlayerAudioTrack[] = input.audioTracks
    .filter((a) => a.initKey && a.chunks.length > 0)
    .map((a) => ({
      id: a.id,
      language: a.language,
      label: a.label,
      isDefault: a.isDefault,
      codec: a.codec ?? "",
      codecString: a.codecString ?? "",
      initKey: a.initKey ?? "",
      initSize: a.initSize ?? 0,
      durationSeconds: a.durationSeconds ?? 0,
      totalSize: a.totalSize ?? 0,
      chunks: a.chunks.map((c) => ({
        key: c.key,
        sizeBytes: c.sizeBytes ?? 0,
        startSeconds: c.startSeconds ?? 0,
      })),
    }));

  // Ingest stores text subs as .vtt/.srt, PGS as .sup (format "pgs"), and bitmap DVD/VobSub
  // as a matroska container (format "matroska"/"mkv"/"dvd_subtitle"/"vobsub", ".mkv"/".sub").
  // PGS and VobSub are image formats: they must be loaded as sidecar files by mpv (sub-add)
  // and never advertised through the HLS master. Everything else is text.
  // OCR twins (SRT recognised from a picture track, PLAY-TRACK-05) are never listed: each rides on its picture track
  // as `ocrTwin`, loaded in its place only where mpv can't draw pictures (Android TV direct rendering).
  const twinsByPictureId = ocrTwinsByPictureId(input.subtitleTracks);
  const subtitleTracks: PlayerSubtitleTrack[] = input.subtitleTracks
    .filter((s) => Boolean(s.objectKey) && !isOcrTwin(s))
    .map((s) => {
      const twin = twinsByPictureId.get(s.id);
      return {
        id: s.id,
        language: s.language,
        label: s.label,
        isDefault: s.isDefault,
        format: resolveSubtitleFormat(s.format, s.objectKey),
        encrypted: false,
        url: s.objectKey ?? "",
        ...(twin?.objectKey ? { ocrTwin: { id: twin.id, url: twin.objectKey } } : {}),
        // A fetched subtitle's source lets the menu offer "Try another version" (PLAY-SUBGET-07).
        ...(s.source ? { source: s.source } : {}),
      };
    });
  const ocrTwins = input.subtitleTracks.filter(isOcrTwin).length;
  const ocrTwinsAttached = subtitleTracks.filter((s) => s.ocrTwin).length;
  if (ocrTwins > 0) {
    console.info(
      "[mpv-subtitles] ocr_twins",
      JSON.stringify({
        ocrTwins,
        ocrTwinsAttached,
        attached: subtitleTracks.filter((s) => s.ocrTwin).map((s) => ({ pictureId: s.id, format: s.format, twinId: s.ocrTwin?.id })),
      }),
    );
  }

  // Map MediaChapter → Chapter (the package needs endSeconds for the chapter
  // pill UI). End of chapter N is the start of chapter N+1, or the video
  // duration for the final chapter. Chapters arrive sorted by startSeconds.
  const chaptersSorted = [...input.chapters].sort((a, b) => a.startSeconds - b.startSeconds);
  const chapters = chaptersSorted.map((c, i) => ({
    title: c.title,
    startSeconds: c.startSeconds,
    endSeconds:
      i + 1 < chaptersSorted.length
        ? chaptersSorted[i + 1].startSeconds
        : input.durationSeconds,
  }));

  console.warn(
    "playback.metadata.counts",
    JSON.stringify({
      videos: videos.length,
      audioTracks: audioTracks.length,
      subtitleTracks: subtitleTracks.length,
      chapters: chapters.length,
      // Help diagnose "track present in DB but stripped by filter" by also
      // surfacing the raw input counts.
      rawAudio: input.audioTracks.length,
      rawSubs: input.subtitleTracks.length,
      ocrTwins,
      ocrTwinsAttached,
      rawChapters: input.chapters.length,
    }),
  );

  return {
    encryptionKeyBase64: "",
    videos,
    audioTracks,
    subtitleTracks,
    chapters,
  };
};

