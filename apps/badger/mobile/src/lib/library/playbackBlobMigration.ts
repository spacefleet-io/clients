import crypto from "react-native-quick-crypto";
import type { SQLiteDatabase } from "react-native-sqlite-storage";
import type {
  AudioTrack,
  MediaChapter,
  MediaFormat,
  SubtitleTrack,
} from "@space/shared/libraryTypes";

type LegacyPayload = {
  formats?: MediaFormat[];
  audioTracks?: AudioTrack[];
  subtitles?: SubtitleTrack[];
  chapters?: MediaChapter[];
};

const randomUuid = () => {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const blobTableExists = async (db: SQLiteDatabase): Promise<boolean> => {
  const res = await db.executeSql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='media_playback_blob' LIMIT 1;"
  );
  const rows = res[0]?.rows;
  return !!rows && rows.length > 0;
};

const parsePayload = (raw: unknown): LegacyPayload => {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as LegacyPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * One-time migration: read legacy media_playback_blob rows and explode each
 * JSON payload into the normalized playback tables, then drop the legacy
 * table. Fresh installs (which never had the blob table) become a no-op.
 *
 * Idempotent — the migration runner records user_version=2, so a successful
 * run will not be retried. If a crash leaves the blob table in place with
 * partial normalized rows, a retry will INSERT OR REPLACE the same rows and
 * drop the table cleanly.
 */
export const normalizePlaybackBlobRows = async (db: SQLiteDatabase) => {
  if (!(await blobTableExists(db))) return;

  const blobRows = (
    await db.executeSql("SELECT media_id, payload, updated_at FROM media_playback_blob;")
  )[0]?.rows;
  const blobLength = blobRows ? blobRows.length : 0;
  const statements: Array<[string, unknown[]]> = [];

  for (let i = 0; i < blobLength; i += 1) {
    const row = blobRows!.item(i) as {
      media_id: string;
      payload: string | null;
      updated_at?: string;
    };
    const mediaId = String(row.media_id);
    const payload = parsePayload(row.payload);
    const updatedAt = row.updated_at ? String(row.updated_at) : new Date().toISOString();

    statements.push(["DELETE FROM media_format_chunks WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", [mediaId]]);
    statements.push(["DELETE FROM media_chapters WHERE format_id IN (SELECT id FROM media_formats WHERE media_id = ?);", [mediaId]]);
    statements.push(["DELETE FROM media_formats WHERE media_id = ?;", [mediaId]]);
    statements.push(["DELETE FROM media_audio_chunks WHERE track_id IN (SELECT id FROM media_audio_tracks WHERE media_id = ?);", [mediaId]]);
    statements.push(["DELETE FROM media_audio_tracks WHERE media_id = ?;", [mediaId]]);
    statements.push(["DELETE FROM media_subtitles WHERE media_id = ?;", [mediaId]]);

    for (const format of payload.formats ?? []) {
      statements.push([
        `INSERT OR REPLACE INTO media_formats (
          id, media_id, file_id, quality, codec, codec_string, bitrate_kbps, init_key, init_size, duration_seconds, total_size, size_mb
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          format.id,
          format.mediaId ?? mediaId,
          format.fileId,
          format.quality,
          format.codec,
          format.codecString ?? null,
          format.bitrateKbps ?? null,
          format.initKey ?? null,
          format.initSize ?? null,
          format.durationSeconds ?? null,
          format.totalSize ?? null,
          format.sizeMb,
        ],
      ]);
      const formatChunks = format.chunks ?? [];
      for (let chunkIndex = 0; chunkIndex < formatChunks.length; chunkIndex += 1) {
        const chunk = formatChunks[chunkIndex]!;
        statements.push([
          "INSERT OR REPLACE INTO media_format_chunks (id, format_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
          [randomUuid(), format.id, chunk.key, chunkIndex, chunk.sizeBytes ?? null, chunk.startSeconds ?? null],
        ]);
      }
      for (const chapter of payload.chapters ?? []) {
        if (chapter.formatId !== format.id) continue;
        statements.push([
          "INSERT OR REPLACE INTO media_chapters (id, format_id, title, start_seconds) VALUES (?, ?, ?, ?);",
          [chapter.id, chapter.formatId, chapter.title, chapter.startSeconds],
        ]);
      }
    }

    for (const track of payload.audioTracks ?? []) {
      statements.push([
        `INSERT OR REPLACE INTO media_audio_tracks (
          id, media_id, file_id, episode_id, language, label, is_default, source, codec, codec_string, init_key, init_size, duration_seconds, total_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          track.id,
          track.mediaId ?? mediaId,
          track.fileId ?? null,
          track.episodeId ?? null,
          track.language,
          track.label,
          track.isDefault ? 1 : 0,
          track.source,
          track.codec ?? null,
          track.codecString ?? null,
          track.initKey ?? null,
          track.initSize ?? null,
          track.durationSeconds ?? null,
          track.totalSize ?? null,
          updatedAt,
        ],
      ]);
      const audioChunks = track.chunks ?? [];
      for (let chunkIndex = 0; chunkIndex < audioChunks.length; chunkIndex += 1) {
        const chunk = audioChunks[chunkIndex]!;
        statements.push([
          "INSERT OR REPLACE INTO media_audio_chunks (id, track_id, chunk_key, order_index, size_bytes, start_seconds) VALUES (?, ?, ?, ?, ?, ?);",
          [randomUuid(), track.id, chunk.key, chunkIndex, chunk.sizeBytes ?? null, chunk.startSeconds ?? null],
        ]);
      }
    }

    for (const subtitle of payload.subtitles ?? []) {
      statements.push([
        `INSERT OR REPLACE INTO media_subtitles (
          id, media_id, file_id, episode_id, language, label, object_key, format, is_default, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          subtitle.id,
          subtitle.mediaId ?? mediaId,
          subtitle.fileId ?? null,
          subtitle.episodeId ?? null,
          subtitle.language,
          subtitle.label,
          subtitle.objectKey ?? null,
          subtitle.format ?? null,
          subtitle.isDefault ? 1 : 0,
          subtitle.source,
          subtitle.createdAt ?? updatedAt,
        ],
      ]);
    }
  }

  if (statements.length > 0) {
    await db.sqlBatch(statements);
  }
  await db.executeSql("DROP TABLE IF EXISTS media_playback_blob;");
};
