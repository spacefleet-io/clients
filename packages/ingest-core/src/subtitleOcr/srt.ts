export type SubtitleCue = { startMs: number; endMs: number; text: string };

export const formatSrtTimestamp = (ms: number): string => {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const milli = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
};

/** One numbered block per cue (from 1), blank line between blocks. */
export const buildSrt = (cues: SubtitleCue[]): string =>
  cues
    .map((cue, i) => `${i + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join("\n");
