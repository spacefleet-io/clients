import React from "react";
import { useNavigation, useRoute } from "@react-navigation/native";
import { MobileProfilesScreen } from "@space/mobile-shell/profiles-screen";
import { profileStore } from "../lib/profiles/profileStore";
import { useLibraryActions } from "../store/library";

const phoneLog = (event: string, data: Record<string, unknown>) => console.info(`profiles.screen.${event}`, JSON.stringify(data));

/**
 * Phone "Who's watching?" (UX-PROF-01): the shared `MobileProfilesScreen` (Parrot's phone asks "Who's listening?" on
 * the same screen). On route `SwitchProfile` (Settings) it closes after a pick; at start it is the navigator's gate.
 */
export const ProfilesScreen = () => {
  const navigation = useNavigation();
  const route = useRoute();
  const { profileMoves } = useLibraryActions();
  const params = (route.params ?? {}) as { mode?: "pick" | "manage" };
  return (
    <MobileProfilesScreen
      store={profileStore}
      moves={profileMoves}
      startMode={params.mode ?? "pick"}
      audience="watching"
      onClose={route.name === "SwitchProfile" ? () => navigation.goBack() : null}
      log={phoneLog}
    />
  );
};
