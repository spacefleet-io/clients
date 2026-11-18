/**
 * Phone/TV progress-save helpers.
 *
 * The resume offer and the watched decision (PLAY-RESUME-01/02: thresholds,
 * `isEpisodeCompleted`, `resolveResumeCandidateSeconds`) and the episode resume
 * storage format (`episode_resume_v1:<id>`, `buildEpisodeResumeValue`,
 * `parseEpisodeResumeValue`) live in `@space/shared/playbackResume`, the one
 * module desktop, phone, TV and web share.
 */
import { resolveResumeCandidateSeconds, type EpisodeResume } from "@space/shared/playbackResume";

/** True when playing this episode will offer "Resume at …" (so the Play button reads "Resume SxEy"). */
export const isEpisodeResumable = (resume: EpisodeResume | null | undefined): boolean =>
  resume != null &&
  resolveResumeCandidateSeconds(resume.progressPct, resume.durationSeconds, null, resume.positionSeconds) !== null;

/**
 * Throttle decision for the periodic progress writer: save when playing and the
 * position moved (or `force` for pause/exit/background). Never writes a
 * near-zero position that would overwrite a real stored one (the desktop
 * "00:00:00" bug) unless the user explicitly started over.
 */
export const shouldPersistProgress = (input: {
  positionSeconds: number;
  durationSeconds: number;
  lastSavedPositionSeconds: number | null;
  force: boolean;
  allowZero?: boolean;
}): boolean => {
  const { positionSeconds, durationSeconds, lastSavedPositionSeconds, force, allowZero } = input;
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return false;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  if (!allowZero && positionSeconds < 1) return false;
  if (lastSavedPositionSeconds !== null && Math.abs(positionSeconds - lastSavedPositionSeconds) < 0.5) return false;
  return force || lastSavedPositionSeconds === null || Math.abs(positionSeconds - lastSavedPositionSeconds) >= 1;
};
