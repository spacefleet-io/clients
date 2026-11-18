const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".hevc": "video/hevc",
  ".h265": "video/hevc",
  ".h264": "video/h264",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
};

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const guessContentMimeType = (path: string): string | null => {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  return IMAGE_MIME_BY_EXT[ext] ?? VIDEO_MIME_BY_EXT[ext] ?? AUDIO_MIME_BY_EXT[ext] ?? DOCUMENT_MIME_BY_EXT[ext] ?? null;
};

export const isImageMimeType = (mimeType: string | null | undefined) =>
  typeof mimeType === "string" && mimeType.startsWith("image/");

export const isVideoMimeType = (mimeType: string | null | undefined) =>
  typeof mimeType === "string" && mimeType.startsWith("video/");

export const isAudioMimeType = (mimeType: string | null | undefined) =>
  typeof mimeType === "string" && mimeType.startsWith("audio/");
