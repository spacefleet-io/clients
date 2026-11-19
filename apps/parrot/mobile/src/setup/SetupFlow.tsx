// Parrot's first setup on a phone (UX-SETUP-08, UX-SETUP-06), the same flow as Badger's phone: the language (step 0,
// from a menu that scrolls), the sign-in (LoginScreen, not counted), then the library key only after a regular sign-in,
// "Your profile" (UX-SETUP-10, "Who's listening?" first when no profile is kept), notifications with the phone's
// permission prompt, and error reports, off unless chosen. Every screen has Back and Next and the numbered ones say
// "step N of M" (UX-SETUP-02); every answer is saved, so a setup left partway reopens at the step left (UX-SETUP-07).
// The walkthrough and its screens are the shared mobile-shell ones (`PhoneSetupFlow`); only Parrot's answers, its key
// screen and its profile step are here.
import React, { useCallback } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { phoneSetupPosition, type PhoneSetupProgress } from "@space/mobile-shell/setup";
import { PhoneSetupFlow, type PhoneSetupStepProps } from "@space/mobile-shell/setup-flow";
import { pickSignedInLanguage, reconcileAfterSignIn } from "../lib/accountLanguage";
import { useSession } from "../state/session";
import { getErrorReportsSetting, setErrorReports } from "../lib/errorReports";
import { ParrotLibraryKeyStep } from "../screens/LibraryKeyScreen";
import { ProfileSetupPhoneStep } from "./ProfileSetupQuestion";

// The shared library key step (UX-KEY-01), numbered as a setup step; Back signs out (the step before is the sign-in).
const LibraryKeyStep = ({ progress, advance, onLanguage }: PhoneSetupStepProps) => {
  const { step, total } = phoneSetupPosition(progress);
  return (
    <ParrotLibraryKeyStep step={step} total={total} onLanguage={(code) => void onLanguage(code)} onKeySaved={() => void advance()} />
  );
};

const PARROT_ERROR_REPORTS = { initial: () => getErrorReportsSetting().errorReports, save: setErrorReports };

/** The walkthrough at `progress.step` (already resolved against the session by the caller). */
export const SetupFlow = ({ progress, save }: { progress: PhoneSetupProgress; save: (next: PhoneSetupProgress) => Promise<void> }) => {
  const token = useSession().session?.token ?? null;
  // Right after the sign-in, the language picked at step 0 meets the account's, asking when they differ
  // (UX-SETUP-08, UX-I18N-07): the sign-in leaves it to the setup while it is open.
  const reconcileLanguage = useCallback(async () => {
    if (token) await reconcileAfterSignIn(token);
  }, [token]);
  // The window pads only the bottom inset and the shared step leaves the top to its parent: below the status bar here
  // (iPhone: the step bar was under the clock), over the sky that stays drawn behind it.
  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
      <PhoneSetupFlow
        progress={progress}
        save={save}
        reconcileLanguage={reconcileLanguage}
        // Setup runs signed in: the language picked is the account's too (UX-I18N-07).
        onLanguage={(code) => pickSignedInLanguage(token, code)}
        notificationsBodyKey="parrot.setup.notificationsBody"
        errorReports={PARROT_ERROR_REPORTS}
        screens={{ libraryKey: LibraryKeyStep, profileSetup: ProfileSetupPhoneStep }}
      />
    </SafeAreaView>
  );
};
