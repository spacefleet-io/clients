// Parrot TV's start (PAR-TV-02): the language first (Badger TV's step 0, UX-TV-32), then the sign-in by pairing (the
// family's TV sign-in with Parrot's pairing, "Use email and password instead" opening the phone's form), the library
// key only after a password sign-in (a pairing brings it), then "Who's listening?" at every start when the account has
// more than one profile, then the TV shell. The phone's numbered setup steps are not asked on a TV: the key comes with
// the pairing, a TV has no notifications to allow, and error reports stay off unless turned on in Settings (REL-LOG-06).
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvLanguageView } from "@space/mobile-shell/tv/TvLanguage";
import { TvProfilesView } from "@space/mobile-shell/tv/TvProfiles";
import { TvSignInScreen } from "@space/mobile-shell/tv/TvSignIn";
import { setParrotLanguage } from "../lib/i18n";
import { stopPlayback } from "../lib/playback";
import { NO_LIBRARY_MOVES } from "@space/shared/profileStore";
import { profileStore, useProfiles } from "../lib/profiles";
import { LibraryKeyScreen } from "../screens/LibraryKeyScreen";
import { LoginScreen } from "../screens/LoginScreen";
import { useSession } from "../state/session";
import { TvMainShell } from "./TvMainShell";
import { HistoryProvider } from "../state/history";
import { ManageProvider } from "../state/manage";
import { PlaylistEditorProvider } from "../state/playlistEditor";
import { useTvPairing } from "./useTvPairing";

const log = scopeLogger("parrot.tv.start");

const profilesLog = (event: string, data: Record<string, unknown>) => console.info(`parrot.tv.profiles.${event}`, JSON.stringify(data));

type TvGatesProps = {
  setup: PhoneSetupProgress;
  save: (next: PhoneSetupProgress) => Promise<void>;
  /** The app's startup screen (the nodding parrot), while the profiles load. */
  spinner: ReactNode;
};

/** Which TV start screen shows, from the saved setup and the session (exported for the tests). */
export const tvStartScreen = (input: {
  setupDone: boolean;
  choosingLanguage: boolean;
  signedIn: boolean;
  hasKey: boolean;
}): "language" | "signIn" | "libraryKey" | "profiles" =>
  input.choosingLanguage || !input.setupDone ? "language" : !input.signedIn ? "signIn" : !input.hasKey ? "libraryKey" : "profiles";

export const TvGates = ({ setup, save, spinner }: TvGatesProps) => {
  const { session, libraryKey } = useSession();
  // The sign-in's language button reopens the language step without undoing the setup.
  const [choosingLanguage, setChoosingLanguage] = useState(false);
  const screen = tvStartScreen({ setupDone: setup.done, choosingLanguage, signedIn: !!session, hasKey: !!libraryKey });
  useEffect(() => log.info("screen", { screen }), [screen]);

  if (screen === "language") {
    return (
      <TvLanguageView
        onPick={(code) => void setParrotLanguage(code)}
        // The TV's setup is the language alone: done once it is chosen, so the sign-in settles it with the account's
        // right away (UX-I18N-07), as on a phone signing in after its setup.
        onNext={async (language) => {
          if (!setup.done) await save({ ...setup, language, step: "signIn", done: true });
          setChoosingLanguage(false);
        }}
      />
    );
  }
  if (screen === "signIn") {
    return <TvSignInScreen usePairing={useTvPairing} passwordForm={<LoginScreen />} onLanguage={() => setChoosingLanguage(true)} />;
  }
  if (screen === "libraryKey") return <LibraryKeyScreen />;
  return <TvProfileGate spinner={spinner} />;
};

/** "Who's listening?" at every start of the TV app when the account has more than one profile (PAR-TV-02, UX-PROF-02). */
const TvProfileGate = ({ spinner }: { spinner: ReactNode }) => {
  const profiles = useProfiles();
  const { session } = useSession();
  const activeId = profiles.profiles.find((profile) => profile.id === profiles.activeId)?.id ?? null;
  // A switch stops the song of the profile before, as on the phone.
  const previous = useRef(activeId);
  useEffect(() => {
    if (previous.current && activeId && previous.current !== activeId) void stopPlayback();
    previous.current = activeId ?? previous.current;
  }, [activeId]);
  if (profiles.status !== "ready") return <>{spinner}</>;
  if (profiles.needsChoice) {
    return (
      <TvProfilesView
        store={profileStore}
        moves={NO_LIBRARY_MOVES}
        startMode="pick"
        inApp={false}
        audience="listening"
        log={profilesLog}
      />
    );
  }
  // The phone's library providers (App.tsx's `Library`): the profile's listening history, the album and artist edits,
  // and the playlists with the heart (`PlaylistEditorProvider` reads `useManage`, so it sits inside `ManageProvider`).
  const active = profiles.profiles.find((profile) => profile.id === activeId) ?? null;
  const owner = { userId: session?.user.id ?? "", profileId: active?.id ?? "main", isMain: active?.isMain ?? true };
  return (
    <HistoryProvider owner={owner}>
      <ManageProvider>
        <PlaylistEditorProvider>
          <TvMainShell />
        </PlaylistEditorProvider>
      </ManageProvider>
    </HistoryProvider>
  );
};
