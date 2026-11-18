// Badger phone's first setup (UX-SETUP-08, UX-SETUP-03), the same flow as Parrot's phone: the language (step 0) and the
// sign in (not counted), then 1 library key (only after a regular sign-in), then, after "Who's watching?", 2 "How
// should titles appear?" (Badger only, while the profile picked never answered it, ACCT-PROF-03), 3 notifications with
// the phone's permission prompt, 4 send error reports (off, REL-LOG-06). Every screen has Back and Next and the
// numbered ones say "step N of M" (UX-SETUP-02); every answer is saved, so a setup left partway reopens at the step
// left (UX-SETUP-07). The walkthrough and its screens are the shared mobile-shell ones (`PhoneSetupFlow`); the sign-in
// and key steps are Badger's own sign-in and key screens with `SetupStepBar` on top, the title step Badger's own
// `TitleLanguageStep`.
import React from "react";
import { phoneSetupPosition, previousPhoneSetupStep, resolvePhoneSetupStep } from "@space/mobile-shell/setup";
import { PhoneSetupFlow } from "@space/mobile-shell/setup-flow";
import { MobileSetupHeader } from "@space/mobile-shell/setup-step";
import { chooseUiLanguage } from "../lib/uiLanguage";
import type { MobileUiLanguage } from "@space/mobile-shell/i18n";
import { useSetupLanguageReconcile } from "../lib/useAccountLanguageSync";
import { getAppSettings, updateAppSettings } from "../lib/appSettings";
import { savePhoneSetup, usePhoneSetup } from "./phoneSetupStore";
import { TitleLanguageStep } from "./TitleLanguageQuestion";
import { useTitleLanguageQuestion } from "../lib/titleLanguageQuestion";
import { useAuth } from "../store/auth";
import { useLibraryStatus } from "../store/library";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TvSetupStepHeader } from "../tv/components/TvSetupStepHeader";

const BADGER_ERROR_REPORTS = {
  initial: () => getAppSettings().errorReports,
  save: (send: boolean) => updateAppSettings({ errorReports: send }),
};

const BADGER_SCREENS = { titleLanguage: TitleLanguageStep };

/** The walkthrough screens the navigator shows as "setup" (the sign-in and key steps are their own screens). */
export const BadgerSetupFlow = () => {
  const saved = usePhoneSetup(true);
  const { user } = useAuth();
  const { needsKey } = useLibraryStatus();
  const reconcileLanguage = useSetupLanguageReconcile();
  // Re-counts the steps once the profile picked and its answer are known (the title step is skipped when answered).
  useTitleLanguageQuestion();
  if (!saved) return null;
  // The saved step can still be the sign-in or the key, done on their own screens since: show the step the navigator
  // resolved, so Next and Back move from the screen on display.
  const progress = { ...saved, step: resolvePhoneSetupStep(saved, { hasKey: !needsKey, signedIn: !!user }) };
  return (
    <PhoneSetupFlow
      progress={progress}
      save={savePhoneSetup}
      // Signed out: the language lives on this phone. Right after the sign-in, sign-up or pairing, the setup settles it
      // with the account's, asking "Which language do you want?" when they differ (UX-SETUP-08, UX-I18N-07); the
      // navigator's `useAccountLanguageSync` leaves that session to the setup. A pick after that (the top-right
      // language button of a numbered step) is the account's too (UX-I18N-01).
      reconcileLanguage={reconcileLanguage}
      onLanguage={(code) => chooseUiLanguage(code, { pushToAccount: Boolean(user) })}
      notificationsBodyKey="setup.notifications.badgerBody"
      errorReports={BADGER_ERROR_REPORTS}
      screens={BADGER_SCREENS}
    />
  );
};

/**
 * Back, "step N of M" and the language button on top of the key screen, Back alone on the sign-in, while the phone's
 * setup is open (UX-SETUP-08: the sign-in is not counted, the key is step 1; the sign-in's own corner holds its
 * language button); their own Sign in / key button is the step's Next. Renders nothing once the setup is done.
 * `onBack` replaces the default move (one step back): the key screen signs out to go back to the sign-in. On the TV:
 * the key's "step N of M" over the TV's steps (`TvSetupStepHeader`), no Back.
 */
export const SetupStepBar = ({ step, onBack }: { step: "signIn" | "libraryKey"; onBack?: () => void }) => {
  const progress = usePhoneSetup(!IS_TV);
  if (IS_TV) return step === "libraryKey" ? <TvSetupStepHeader step="libraryKey" /> : null;
  if (!progress || progress.done) return null;
  const shown = { ...progress, step };
  const { step: n, total } = phoneSetupPosition(shown);
  const previous = previousPhoneSetupStep(shown);
  const back = onBack ?? (previous ? () => void savePhoneSetup({ ...progress, step: previous }) : undefined);
  // The key step is signed in: the language picked is the account's too.
  const language = step === "libraryKey" ? (code: MobileUiLanguage) => void chooseUiLanguage(code, { pushToAccount: true }) : undefined;
  return <MobileSetupHeader step={n} total={total} onBack={back} onLanguage={language} />;
};
