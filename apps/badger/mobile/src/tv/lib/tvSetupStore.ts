/**
 * Badger TV's setup progress (UX-SETUP-08), kept on this TV: whether the language was chosen (step 0) and whether the
 * sign-in brought the key (pairing). The shared phone progress store and its live copy (`@space/mobile-shell/setup`),
 * under the TV's own key; the order and the numbering are `./tvSetup`.
 */
import { useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createPhoneSetupStore, INITIAL_PHONE_SETUP, type PhoneSetupProgress } from "@space/mobile-shell/setup";
import { createLivePhoneSetup } from "@space/mobile-shell/setup-live";
import { scopeLogger } from "@space/mobile-shell/logger";
import { loadAppSettings } from "../../lib/appSettings";
import { tvSetupForSession } from "./tvSetup";

const log = scopeLogger("tv.setup");

export const TV_SETUP_STORAGE_KEY = "sf:tv-setup:v1";

/**
 * A TV with no saved progress that already answered "Send error reports?" was signed in before this step existed: it
 * counts as having chosen its language.
 */
const tvSetup = createLivePhoneSetup({
  store: createPhoneSetupStore({ asyncStorage: AsyncStorage, key: TV_SETUP_STORAGE_KEY }),
  unsaved: async () => ((await loadAppSettings()).errorReportsDecided ? { ...INITIAL_PHONE_SETUP, step: "signIn" } : INITIAL_PHONE_SETUP),
});

export const {
  load: loadTvSetup,
  get: getTvSetup,
  save: saveTvSetup,
  markPaired: markTvSetupPaired,
  useProgress: useTvSetupProgress,
  reset: __resetTvSetupForTests,
} = tvSetup;

/**
 * The TV's setup progress for the navigator (null until read, and always off the TV), kept in line with the session:
 * signed in marks the language as chosen, signed out forgets a pairing (`tvSetupForSession`).
 */
export const useTvSetup = (enabled: boolean, session: { signedIn: boolean; loading: boolean }): PhoneSetupProgress | null => {
  const progress = useTvSetupProgress(enabled);
  const { signedIn, loading } = session;
  useEffect(() => {
    if (!enabled || !progress || loading) return;
    const next = tvSetupForSession(progress, signedIn);
    if (!next) return;
    log.info("session", { signedIn, languageChosen: next.step !== "language", pairedKey: next.pairedKey });
    void saveTvSetup(next);
  }, [enabled, progress, signedIn, loading]);
  return progress;
};
