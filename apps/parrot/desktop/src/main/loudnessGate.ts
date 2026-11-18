import type { ParrotMeasuredLoudness } from "../shared/ipc";

/**
 * PAR-PLAY-03 item 2 / PAR-UP-03: the renderer measures a song's loudness as soon as the song shows in the library, so
 * during an import each measured song was a publish racing the import's own publish (one `version_conflict` and a
 * replay per song). While an import runs the measured values are held, the latest per song, and kept in one publish
 * when it ends.
 */
export const createLoudnessGate = <R>({
  save,
  heldResult,
  log,
}: {
  save: (measured: ParrotMeasuredLoudness[]) => Promise<R>;
  /** What the renderer gets back for a held batch: the library as it is now. */
  heldResult: () => Promise<R>;
  log: (line: string) => void;
}) => {
  const held = new Map<string, ParrotMeasuredLoudness>();
  let paused = false;
  return {
    pause: () => {
      paused = true;
    },
    save: (measured: ParrotMeasuredLoudness[]): Promise<R> => {
      if (!paused) return save(measured);
      for (const entry of measured) held.set(entry.trackId, entry);
      log(`[loudness] import running: holding ${measured.length} song(s), ${held.size} waiting`);
      return heldResult();
    },
    /** Ends the pause and keeps every held value in one publish; resolves once that publish settled. */
    resume: async (): Promise<void> => {
      paused = false;
      if (held.size === 0) return;
      const measured = [...held.values()];
      held.clear();
      log(`[loudness] import over: keeping the ${measured.length} held song(s)`);
      await save(measured);
    },
  };
};
