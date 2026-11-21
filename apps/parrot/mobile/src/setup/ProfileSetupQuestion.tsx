// "Your profile" (UX-SETUP-10) in Parrot's phone setup: a numbered step right after the library key (or the sign-in
// when pairing brought the key). "Who's listening?" (UX-PROF-01) comes first when the account has several profiles and
// none is kept on this phone, not counted, as Badger's "Who's watching?" is; a profile already set up then skips the
// step. After the setup, `App.tsx`'s `ProfileGate` shows the same step on its own and the update window (UX-UPDATE-01).
import React from "react";
import { View } from "react-native";
import { MobileProfilesScreen } from "@space/mobile-shell/profiles-screen";
import { PhoneSetupProfileStep } from "@space/mobile-shell/profile-setup-step";
import type { PhoneSetupStepProps } from "@space/mobile-shell/setup-flow";
import { parrotProfileMoves, profileStore, useProfiles } from "../lib/profiles";

export const profileSetupLog = (event: string, data: Record<string, unknown>) => console.info(`parrot.profile_setup.${event}`, JSON.stringify(data));
const pickLog = (event: string, data: Record<string, unknown>) => console.info(`parrot.profiles.screen.${event}`, JSON.stringify(data));

export const ProfileSetupPhoneStep = (props: PhoneSetupStepProps) => {
  const { profiles, activeId, needsChoice, status } = useProfiles();
  if (status !== "ready") return <View testID="setup-profile-wait" />;
  if (needsChoice) {
    return <MobileProfilesScreen store={profileStore} moves={parrotProfileMoves} startMode="pick" audience="listening" onClose={null} log={pickLog} />;
  }
  return <PhoneSetupProfileStep {...props} profile={profiles.find(({ id }) => id === activeId) ?? null} log={profileSetupLog} />;
};
