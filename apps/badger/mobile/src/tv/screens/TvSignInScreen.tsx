import React from "react";
import { TvSignInScreen as SharedTvSignInScreen } from "@space/mobile-shell/tv/TvSignIn";
import { LoginScreen } from "../../screens/LoginScreen";
import { useTvPairing } from "../lib/useTvPairing";
import { getTvSetup, saveTvSetup } from "../lib/tvSetupStore";

/** Back to "Choose your language" (UX-TV-31): the step's Next brings the sign-in back. */
const openLanguageStep = () => {
  const progress = getTvSetup();
  if (progress) void saveTvSetup({ ...progress, step: "language" });
};

/**
 * Badger TV's sign-in (ACCT-PAIR-01): the family's TV sign-in (`@space/mobile-shell/tv/TvSignIn`) with Badger's pairing,
 * its phone sign-in as the password form and its language step.
 */
export const TvSignInScreen = () => (
  <SharedTvSignInScreen usePairing={useTvPairing} passwordForm={<LoginScreen />} onLanguage={openLanguageStep} />
);
