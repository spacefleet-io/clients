/**
 * Re-export surface for pure helpers that used to live in this file before
 * the tier-1 relocation. The hook `useExternalMpvController` returned 7
 * callbacks that wrapped `window.sf.sendExternalMpv*`; tier-3 task F
 * collapsed that surface — renderers now talk to {@link MpvClient}
 * (`PreloadMpvClient`) directly and inline the gating/polling helpers.
 *
 * Pure helpers (buildTrackSignature, hasUsableExternalTrackState,
 * isExternalMpvResponseError, isExternalMpvResponseReady,
 * pollMetadataApplied, pollVoConfigured) keep this stable re-export point
 * so consumers that depend on them through `@space/desktop-mpv-playback`
 * don't need to rewrite imports.
 */
export {
  buildTrackSignature,
  hasUsableExternalTrackState,
  isExternalMpvResponseError,
  isExternalMpvResponseReady,
  pollMetadataApplied,
  pollVoConfigured,
} from "@space/mpv-protocol";
