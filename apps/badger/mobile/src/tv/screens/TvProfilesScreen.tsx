import React from "react";
import { useNavigation, useRoute } from "@react-navigation/native";
import { TvProfilesView } from "@space/mobile-shell/tv/TvProfiles";
import { profileStore } from "../../lib/profiles/profileStore";
import { useLibraryActions } from "../../store/library";

const tvLog = (event: string, data: Record<string, unknown>) => console.info(`tv.profiles.${event}`, JSON.stringify(data));

/**
 * "Who's watching?" on the TV (UX-PROF-01, UX-PROF-02): the shared TV profile picker (`TvProfilesView`) on Badger's
 * routes. At start it is the start gate (route `Profiles`); from Settings it sits on the stack (route `SwitchProfile`,
 * `{ mode: "manage" }` or `{ mode: "pick" }`) and closes after a pick.
 */
export const TvProfilesScreen = () => {
  const navigation = useNavigation();
  const route = useRoute();
  const params = (route.params ?? {}) as { mode?: "pick" | "manage" };
  const { profileMoves } = useLibraryActions();
  return (
    <TvProfilesView
      store={profileStore}
      moves={profileMoves}
      startMode={params.mode ?? "pick"}
      inApp={route.name === "SwitchProfile"}
      audience="watching"
      onPicked={() => navigation.goBack()}
      onClose={() => navigation.goBack()}
      log={tvLog}
    />
  );
};
