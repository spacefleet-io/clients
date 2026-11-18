/**
 * Badger phone's setup progress (UX-SETUP-03, UX-SETUP-07), kept on this phone after every answer so a setup left
 * partway reopens at the step left. The order, the moves and the store are the shared `@space/mobile-shell/setup`
 * ones, the same as Parrot's phone (UX-SETUP-08): language, sign in, then library key (only after a regular sign-in),
 * notifications, error reports.
 *
 * The TV keeps its own gates (UX-SETUP-04 is a separate rule) and never reads this store.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { askTitleLanguageInSetup, createPhoneSetupStore, INITIAL_PHONE_SETUP } from "@space/mobile-shell/setup";
import { createLivePhoneSetup } from "@space/mobile-shell/setup-live";
import { loadAppSettings } from "../lib/appSettings";
import { titleLanguageAskedInSetup } from "../lib/titleLanguageQuestion";

// Badger shows titles, so its setup asks how they appear (ACCT-PROF-03); Parrot's phone never does.
askTitleLanguageInSetup(titleLanguageAskedInSetup);

export const PHONE_SETUP_STORAGE_KEY = "sf:phone-setup:v1";

/**
 * A phone with no saved progress that already answered "Send error reports?" was set up before this walkthrough
 * existed (sign-in, key and that question were its gates), so it has nothing left to set up.
 */
const phoneSetup = createLivePhoneSetup({
  store: createPhoneSetupStore({ asyncStorage: AsyncStorage, key: PHONE_SETUP_STORAGE_KEY }),
  unsaved: async () => ((await loadAppSettings()).errorReportsDecided ? { ...INITIAL_PHONE_SETUP, done: true } : INITIAL_PHONE_SETUP),
});

export const {
  load: loadPhoneSetup,
  get: getPhoneSetup,
  save: savePhoneSetup,
  markPaired: markPhoneSetupPaired,
  subscribe: subscribePhoneSetup,
  useProgress: usePhoneSetup,
  reset: __resetPhoneSetupForTests,
} = phoneSetup;
