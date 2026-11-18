// The stand-in for @space/mobile-self-update in every build without self-update (Play, iOS, any build without
// SF_FOSS=1): the same names, doing nothing, with no updater code behind them (REL-UPD-06).
import type { SelfUpdateConsent as Consent } from "./SelfUpdateConsent";
import type { SelfUpdateDialog as Dialog } from "./SelfUpdateDialog";
import type { SelfUpdateSettings as Settings } from "./SelfUpdateSettings";
import type { startSelfUpdate as start } from "./controller";

export const SelfUpdateConsent: typeof Consent = () => null;
export const SelfUpdateDialog: typeof Dialog = () => null;
export const SelfUpdateSettings: typeof Settings = () => null;
export const startSelfUpdate: typeof start = async () => undefined;
