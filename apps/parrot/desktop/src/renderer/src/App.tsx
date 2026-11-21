import { useCallback, useEffect, useMemo, useState } from "react";
import { CloseLabelProvider, RenderBoundary } from "@space/ui";
import type { ParrotState } from "../../shared/ipc";
import { translator } from "./i18n";
import SignIn from "./SignIn";
import Setup from "./Setup";
import Library from "./Library";
import { LoadingMascot } from "./LoadingMascot";
import { ParrotSystemUpdatePrompt, UpdateReadyNotice } from "./updates";
import { UpdateRequiredGate } from "./UpdateRequiredGate";

/**
 * UX-SETUP-08: a new computer first picks its language (setup step 0), then signs in on its own screen, then runs the
 * numbered setup until it is done (UX-SETUP-06/07); then the library with its player. A computer whose setup is past
 * the language (or done) opens straight on the sign-in when signed out.
 */
export default function App() {
  const [state, setState] = useState<ParrotState | null>(null);
  const refresh = useCallback(async () => setState(await window.parrot.getState()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const t = useMemo(() => translator(state?.setup.language ?? "en"), [state?.setup.language]);
  useEffect(() => {
    if (state) document.documentElement.lang = state.setup.language;
  }, [state]);

  if (!state) {
    return (
      <div className="flex h-screen items-center justify-center">
        <LoadingMascot />
      </div>
    );
  }
  const ready = state.setup.done && state.user && state.hasLibraryKey;
  const screen = !state.user
    ? !state.setup.done && state.setup.step === "language"
      ? "setup"
      : "sign-in"
    : ready
      ? "library"
      : "setup";
  // UX-I18N-01: the corner close button of shared dialogs (sign-out key check) reads in Parrot's language.
  // UX-CRASH-01: a crashing screen blanks only itself; moving to the next screen clears the error; "Try again" reads
  // the app's state from main again and mounts the screen anew once it is in.
  return (
    <CloseLabelProvider label={t("close")}>
      <RenderBoundary name={`screen:${screen}`} resetKey={screen} className="m-8" onRetry={refresh}>
        {screen === "sign-in" ? (
          <SignIn t={t} state={state} onState={setState} />
        ) : screen === "library" ? (
          <Library t={t} state={state} onState={setState} />
        ) : (
          <Setup t={t} state={state} onState={setState} />
        )}
      </RenderBoundary>
      {/* REL-UPD-01: a version downloaded in the background offers "Restart now", on every screen. */}
      <UpdateReadyNotice t={t} />
      {/* REL-UPD-07: a copy from SpaceFleet's packages asks before updating through the package manager. */}
      <ParrotSystemUpdatePrompt language={state.setup.language} />
      {/* REL-CD-29: a build the API refuses (or release-status marks below the minimum) only offers the update. */}
      <UpdateRequiredGate language={state.setup.language} />
    </CloseLabelProvider>
  );
}
