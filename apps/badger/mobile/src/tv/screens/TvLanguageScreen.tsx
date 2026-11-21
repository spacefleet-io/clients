import React from "react";
import { isMobileUiLanguage } from "@space/mobile-shell/i18n";
import { TvLanguageView } from "@space/mobile-shell/tv/TvLanguage";
import { chooseUiLanguage } from "../../lib/uiLanguage";
import { getTvSetup, saveTvSetup } from "../lib/tvSetupStore";

/**
 * Badger TV's step 0 (UX-SETUP-08, UX-TV-32): the shared "Choose your language" (`TvLanguageView`). A pick switches the
 * app at once, kept on this TV (the account takes it after the sign-in, UX-I18N-07); Next marks the language as chosen
 * and the navigator shows the sign-in.
 */
export const TvLanguageScreen = () => (
  <TvLanguageView
    onPick={(code) => {
      if (isMobileUiLanguage(code)) void chooseUiLanguage(code, { pushToAccount: false });
    }}
    onNext={async (language) => {
      const progress = getTvSetup();
      if (!progress) return;
      await saveTvSetup({ ...progress, step: "signIn", language });
    }}
  />
);
