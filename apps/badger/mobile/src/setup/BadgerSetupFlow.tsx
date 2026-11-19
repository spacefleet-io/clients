// Badger phone's first setup (UX-SETUP-08, UX-SETUP-03), the same flow as Parrot's phone: the language (step 0) and the
// sign in (not counted), then 1 library key (only after a regular sign-in), then, after "Who's watching?", 2 "Your
// profile" (while the profile picked has it pending, UX-SETUP-10), 3 "How should titles appear?" (Badger only, while
// the profile picked never answered it, ACCT-PROF-03), 4 notifications with the phone's permission prompt, 5 send
// error reports (off, REL-LOG-06). Every screen has Back and Next, Back being the pill at the bottom: beside Next on
// the numbered screens, alone on the sign-in (its Sign in button is its Next), never a top "‹ Back" (Chris 2026-11-18).
// The numbered ones say "step N of M" (UX-SETUP-02); every answer is saved, so a setup left partway reopens at the step
// left (UX-SETUP-07). The walkthrough and its screens are the shared mobile-shell ones (`PhoneSetupFlow`); the sign-in
// and key steps are Badger's own screens, the key with `SetupStepBar` on top and the sign-in with `SignInSetupBack` at
// its bottom, the profile step the shared one fed with the profile picked (`ProfileSetupPhoneStep`), the title step
// Badger's own `TitleLanguageStep`.
import React from "react";
import { phoneSetupPosition, previousPhoneSetupStep, resolvePhoneSetupStep } from "@space/mobile-shell/setup";
import { PhoneSetupFlow } from "@space/mobile-shell/setup-flow";
import { MobileSetupBackFooter, MobileSetupHeader } from "@space/mobile-shell/setup-step";
import { chooseUiLanguage } from "../lib/uiLanguage";
import type { MobileUiLanguage } from "@space/mobile-shell/i18n";
import { useSetupLanguageReconcile } from "../lib/useAccountLanguageSync";
import { getAppSettings, updateAppSettings } from "../lib/appSettings";
import { savePhoneSetup, usePhoneSetup } from "./phoneSetupStore";
import { ProfileSetupPhoneStep } from "./ProfileSetupQuestion";
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

const BADGER_SCREENS = { profileSetup: ProfileSetupPhoneStep, titleLanguage: TitleLanguageStep };

/** The walkthrough screens the navigator shows as "setup" (the sign-in and key steps are their own screens). */
export const BadgerSetupFlow = () => {
  const saved = usePhoneSetup(true);
  const { user } = useAuth();
  const { needsKey } = useLibraryStatus();
  const reconcileLanguage = useSetupLanguageReconcile();
  // Re-counts the steps once the profile picked and its answers are known (the profile and title steps are skipped
  // when answered; `useProfiles` underneath re-renders on every profile list change).
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
 * "Step N of M" and the language button on top of the key screen while the phone's setup is open (UX-SETUP-08: the
 * sign-in is not counted, the key is step 1); its own key button is the step's Next and its Back the pill under the
 * card (it signs out, back to the sign-in). Renders nothing once the setup is done. On the TV: the key's "step N of M"
 * over the TV's steps (`TvSetupStepHeader`).
 */
export const SetupStepBar = () => {
  const progress = usePhoneSetup(!IS_TV);
  if (IS_TV) return <TvSetupStepHeader step="libraryKey" />;
  if (!progress || progress.done) return null;
  const { step: n, total } = phoneSetupPosition({ ...progress, step: "libraryKey" });
  // The key step is signed in: the language picked is the account's too.
  return <MobileSetupHeader step={n} total={total} onLanguage={(code: MobileUiLanguage) => void chooseUiLanguage(code, { pushToAccount: true })} />;
};

/**
 * The sign-in's Back while the phone's setup is open: the setup's Back pill at the bottom of the screen, back to the
 * language step (UX-SETUP-08, Chris 2026-11-18: no top "‹ Back"; Main 2026-11-19). Nothing on the TV, whose sign-in
 * has no Back, or once the setup is done.
 */
export const SignInSetupBack = () => {
  const progress = usePhoneSetup(!IS_TV);
  if (IS_TV || !progress || progress.done) return null;
  const previous = previousPhoneSetupStep({ ...progress, step: "signIn" });
  return previous ? <MobileSetupBackFooter onBack={() => void savePhoneSetup({ ...progress, step: previous })} /> : null;
};
