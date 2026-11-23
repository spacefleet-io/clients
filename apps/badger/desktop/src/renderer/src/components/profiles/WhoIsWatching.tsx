import { useEffect } from "react";
import { WhoIsWatchingPanel } from "@space/ui/profiles";
import { profileStore, useProfiles } from "@/lib/profileStore";
import { rendererLogger } from "@/logger";
import { useProfileScreenDeps } from "./profileScreenDeps";

const log = rendererLogger.child({ scope: "profiles-picker" });

/**
 * "Who's watching?" (UX-PROF-01), in front of the whole app at every start of an account with more than one profile
 * (UX-PROF-02) and when switching profile. Picking a profile opens the app on its viewing state in one step, with no
 * sign-in. Profiles can also be added and managed from here, as on the phone and TV (`WhoIsWatchingPanel`, shared
 * with the web player).
 */
export default function WhoIsWatching() {
  const snapshot = useProfiles();
  const deps = useProfileScreenDeps();

  useEffect(() => {
    log.info({ count: snapshot.profiles.length, stale: snapshot.stale }, "profiles.picker.shown");
    // The list may have changed on another device since the app started.
    void profileStore.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening of the picker
  }, []);

  return (
    <div
      data-testid="profiles-picker"
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center gap-10 overflow-y-auto bg-background p-8 text-foreground"
    >
      <WhoIsWatchingPanel {...deps} />
    </div>
  );
}
