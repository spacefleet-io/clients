/**
 * Chapters of the file being played (PLAY-CHAP-01).
 *
 * Chapter rows hang off a format, but every format of one file is a transcode of the same timeline and
 * the runtime writes chapter rows only for the source job's format. A lower-quality copy (an offline
 * download, a format-job output) has none of its own, so the rows of any other format of the same file
 * are used. Same rule as desktop `buildPlaybackChapters`.
 */
import type { MediaChapter } from "@space/shared/libraryTypes";

export const chaptersForFile = <F extends { id: string }>(
  chapters: readonly MediaChapter[],
  playedFormats: readonly F[],
  fileFormats: readonly F[],
): MediaChapter[] => {
  const withChapters = (format: F) => chapters.some((chapter) => chapter.formatId === format.id);
  // One format's rows only: the same timeline stored under several formats must not list twice.
  const source = playedFormats.find(withChapters) ?? fileFormats.find(withChapters);
  if (!source) return [];
  return chapters
    .filter((chapter) => chapter.formatId === source.id)
    .sort((a, b) => a.startSeconds - b.startSeconds);
};
