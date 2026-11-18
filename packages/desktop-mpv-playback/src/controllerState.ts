export type PlaybackLaunchPlan = {
  openPlayback: boolean;
  showResumePrompt: boolean;
  deferForPrompt: boolean;
};

const REQUEST_DEDUPE_TTL_MS = 5_000;
const handledPlaybackRequests = new Map<string, number>();

export const shouldHandlePlaybackRequest = (requestKey: string, now = Date.now()) => {
  for (const [key, startedAt] of handledPlaybackRequests.entries()) {
    if (now - startedAt > REQUEST_DEDUPE_TTL_MS) {
      handledPlaybackRequests.delete(key);
    }
  }
  if (handledPlaybackRequests.has(requestKey)) {
    return false;
  }
  handledPlaybackRequests.set(requestKey, now);
  return true;
};

export const getPlaybackLaunchPlan = (resumeCandidateTime: number | null): PlaybackLaunchPlan => {
  // The candidate is pre-vetted by resolveResumeCandidateSeconds (@space/shared/playbackResume:
  // below either PLAY-RESUME-01 threshold or watched maps to null), so this is a plain null-check.
  if (resumeCandidateTime !== null) {
    return {
      openPlayback: false,
      showResumePrompt: true,
      deferForPrompt: true,
    };
  }
  return {
    openPlayback: true,
    showResumePrompt: false,
    deferForPrompt: false,
  };
};

export const shouldClearPlaybackLaunchUi = (
  hadLaunchUi: boolean,
  playbackOpen: boolean,
  resumePromptOpen: boolean,
  deferForPrompt: boolean
) => hadLaunchUi && !playbackOpen && !resumePromptOpen && !deferForPrompt;

export const getPlaybackLaunchMedia = <T>(currentMedia: T, latestMedia: T | null | undefined): T =>
  latestMedia ?? currentMedia;
