/**
 * Animated or still sky (UX-SKY-01). The sky's stars never move; "animated" means shooting stars fly (about one every
 * 5-8 s, ~24% of one core on the reference phone, only while a star flies), "still" means they are shown frozen.
 *
 * The user's setting "Animated background" decides: On / Off force it, Automatic is animated except on a phone Android
 * flags as low-RAM (`ActivityManager.isLowRamDevice()`; always false on iOS). The flag is constant per device, so it is
 * asked once at startup (in parallel with the other startup loads, before the first screen) and never stored: there is
 * no probe, no measured verdict and nothing persisted. A verdict stored under `sf:sky-detection:v1` by the earlier
 * probe-based builds is simply never read.
 */
import { useAppSettings, type AnimatedBackground } from "./appSettings";
import { scopeLogger } from "@space/mobile-shell/logger";
import { isLowRamDevice } from "../native/LibrarySync";
import type { MobileSkyMode } from "@space/mobile-shell/components";

const log = scopeLogger("sky-mode");

let lowRam = false;
let loadPromise: Promise<boolean> | null = null;

/** Asks the OS once whether this phone is low-RAM. Call at startup; the answer is read synchronously afterwards. */
export const loadLowRamDevice = (): Promise<boolean> => {
  loadPromise ??= isLowRamDevice().then((flagged) => {
    lowRam = flagged;
    log.info("low-ram", { lowRam });
    return flagged;
  });
  return loadPromise;
};

/** The setting first; Automatic is the still sky only on a low-RAM phone. */
export const resolveSkyMode = (setting: AnimatedBackground, lowRamDevice: boolean): MobileSkyMode => {
  if (setting === "on") return "animated";
  if (setting === "off") return "static";
  return lowRamDevice ? "static" : "animated";
};

/** What Automatic resolves to on this phone (valid once `loadLowRamDevice` settled), for the Settings row. */
export const automaticSkyMode = (): MobileSkyMode => resolveSkyMode("auto", lowRam);

/** Value for `MobileSkyModeProvider`. */
export const useSkyMode = (): MobileSkyMode => {
  const [settings] = useAppSettings();
  return resolveSkyMode(settings.animatedBackground, lowRam);
};

/** Test hook: forget the answer so the next `loadLowRamDevice` asks again. */
export const __resetSkyModeForTests = (): void => {
  lowRam = false;
  loadPromise = null;
};
