// "Your profile" (UX-SETUP-10) in Badger: a numbered step of the phone's first setup, right after the key and "Who's
// watching?" (UX-SETUP-03, `ProfileSetupPhoneStep`), and otherwise (a profile picked later, the TV, or "Choose my
// avatar" in the update window, UX-UPDATE-01) on its own screen right after the profile is picked
// (`ProfileSetupScreen`). The phone draws the shared mobile-shell step, the TV its own (`TvProfileSetupScreen`).
import React from "react";
import { View } from "react-native";
import { scopeLogger } from "@space/mobile-shell/logger";
import { ProfileSetupStep } from "@space/mobile-shell/profile-setup-step";
import { phoneSetupPosition } from "@space/mobile-shell/setup";
import type { PhoneSetupStepProps } from "@space/mobile-shell/setup-flow";
import { useActiveProfile } from "../lib/profileSetupQuestion";
import { IS_TV } from "../tv/lib/tvRuntime";
import { useTvProfileSetupPosition } from "../tv/lib/tvSetupStore";
import { TvProfileSetupScreen } from "../tv/screens/TvProfileSetupScreen";

const log = scopeLogger("profile-setup");
const logEvent = (event: string, data: Record<string, unknown>) => log.info(event, data);

/** The phone setup's numbered step (after the key and "Who's watching?", before the title question). */
export const ProfileSetupPhoneStep = ({ progress, advance, back, onLanguage }: PhoneSetupStepProps) => {
  const profile = useActiveProfile();
  // The sky alone until the profile picked is known: a profile already set up skips the step.
  if (!profile) return <View testID="setup-profile-wait" />;
  const { step, total } = phoneSetupPosition(progress);
  return (
    <ProfileSetupStep
      key={profile.id}
      profile={profile}
      position={{ step, total }}
      onBack={back}
      onLanguage={(code) => void onLanguage(code)}
      // Kept counted once answered here, so the steps after it keep their numbers.
      onDone={() => void advance({ profileSetupAnswered: true })}
      log={logEvent}
    />
  );
};

/**
 * On its own, no step count on the phone (the TV counts it while its setup runs): the navigator moves on once the
 * answer is saved. `onBack` returns to the update window it was opened from.
 */
export const ProfileSetupScreen = ({ onBack }: { onBack?: () => void }) => {
  const profile = useActiveProfile();
  if (!profile) return <View testID="profile-setup-wait" />;
  const done = () => logEvent("profile_setup.done", { profileId: profile.id, tv: IS_TV });
  if (IS_TV) return <TvProfileSetupStandalone key={profile.id} profile={profile} onBack={onBack} onDone={done} />;
  return <ProfileSetupStep key={profile.id} profile={profile} onBack={onBack} onDone={done} log={logEvent} />;
};

const TvProfileSetupStandalone = (props: Omit<React.ComponentProps<typeof TvProfileSetupScreen>, "stepPosition">) => (
  <TvProfileSetupScreen {...props} stepPosition={useTvProfileSetupPosition()} />
);
