// Whether this build has a Google Cast sender (UX-TV-03). The Google-free Android build (SF_FOSS=1) has none: Metro
// takes googleCastAvailable.foss.ts there (packages/mobile-shell/foss.cjs) and the player shows no Cast button.
export const googleCastAvailable: boolean = true;
