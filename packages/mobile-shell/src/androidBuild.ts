// Which Android build this bundle is (PLAT-MOBILE-06): the Google Play build. The Google-free build (SF_FOSS=1, the
// F-Droid recipe and the APK we publish) swaps in androidBuild.foss.ts (foss.cjs). The update-required screen reads it
// to send a hand-installed APK to the right download (the two builds cannot update each other, WEB-DL-05).
export const ANDROID_BUILD: "play" | "foss" = "play";
