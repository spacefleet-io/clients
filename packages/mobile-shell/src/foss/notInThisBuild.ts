// The Google-free Android build (SF_FOSS=1, foss.cjs) resolves the Firebase modules to this file. It must load without
// throwing: in a release bundle Metro hands a module that throws while loading to the global fatal handler, before the
// importer's catch runs, so the app would die (issue #2497). The importer checks the marker instead (Badger's
// pushHandler.loadMessaging) and leaves the feature off.
export const notInThisBuild = true;
