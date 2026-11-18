// @space/mobile-self-update (REL-UPD-06): the self-update of a Badger or Parrot APK installed by hand, offered only
// when no store or updater app manages the install and its user said yes. Every Google-free build contains it
// (SF_FOSS=1: our repository, website, GitHub and f-droid.org alike); every other build resolves this package to
// `index.off.ts` and leaves the native module and its REQUEST_INSTALL_PACKAGES permission out
// (packages/mobile-shell/foss.cjs).
export { SelfUpdateConsent } from "./SelfUpdateConsent";
export { SelfUpdateDialog } from "./SelfUpdateDialog";
export { SelfUpdateSettings } from "./SelfUpdateSettings";
export { startSelfUpdate } from "./controller";
