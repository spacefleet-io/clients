/**
 * The audio formats table, with no Node imports so a renderer can read it too (Parrot desktop's window drop, UX-ADD-02).
 */

/** Like `path.extname`, lowercased: `""` for no extension or a dot name. */
const extensionOf = (file: string): string => {
  const base = file.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

export type ParrotAudioFormat = { codec: string; container: string; mime: string; lossless: boolean };

/**
 * The audio files Parrot imports (PAR-UP-01), by extension, with the codec facts used when the file's own header
 * does not say. An `.m4a` is AAC unless its header says Apple Lossless (readTrack marks it `alac`; Parrot decodes it
 * itself, PAR-FMT-01). AIFF, WMA and the other formats the apps cannot play wait for the decoding of PAR-FMT-03.
 */
export const PARROT_AUDIO_FORMATS: Readonly<Record<string, ParrotAudioFormat>> = {
  ".mp3": { codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false },
  ".flac": { codec: "flac", container: "flac", mime: "audio/flac", lossless: true },
  ".m4a": { codec: "aac", container: "mp4", mime: "audio/mp4", lossless: false },
  ".aac": { codec: "aac", container: "adts", mime: "audio/aac", lossless: false },
  ".ogg": { codec: "vorbis", container: "ogg", mime: "audio/ogg", lossless: false },
  ".oga": { codec: "vorbis", container: "ogg", mime: "audio/ogg", lossless: false },
  ".opus": { codec: "opus", container: "ogg", mime: "audio/ogg", lossless: false },
  ".wav": { codec: "pcm_s16le", container: "wav", mime: "audio/wav", lossless: true },
};

export const parrotAudioFormatFor = (file: string): ParrotAudioFormat | null =>
  PARROT_AUDIO_FORMATS[extensionOf(file)] ?? null;

/** PAR-UP-01: only audio files are imported; covers, booklets, logs, cue sheets and `.lrc` files are not. */
export const isParrotAudioFile = (file: string): boolean => parrotAudioFormatFor(file) !== null;
