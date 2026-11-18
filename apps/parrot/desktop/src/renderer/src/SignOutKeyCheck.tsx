import { useCallback, useMemo } from "react";
import { useSignOutWithKeyCheck as useSharedSignOutWithKeyCheck, type SignOutWithKeyCheck } from "@space/ui";
import type { ParrotState } from "../../shared/ipc";
import type { Translate } from "./i18n";

/**
 * Parrot desktop's Sign out (ACCT-DEV-03, shared `useSignOutWithKeyCheck` in @space/ui): when this computer holds
 * the key (`state.asksKeySavedBeforeSignOut`, decided in main from the stored key) it first asks whether the key was
 * saved. Parrot desktop cannot show the key, so there is no "Show my key". Without a key it signs out at once.
 */
export function useSignOutWithKeyCheck({
  t,
  state,
  onSignedOut,
}: {
  t: Translate;
  state: ParrotState;
  onSignedOut: (state: ParrotState) => void;
}): SignOutWithKeyCheck {
  const holds = state.asksKeySavedBeforeSignOut;
  const holdsKey = useCallback(() => {
    console.info(`[parrot-sign-out] sign out requested, holdsKey=${holds}`);
    return holds;
  }, [holds]);

  const signOut = useCallback(async () => {
    console.info("[parrot-sign-out] signing out (user's own Sign out)");
    onSignedOut(await window.parrot.signOut());
  }, [onSignedOut]);

  const text = useMemo(
    () => ({
      title: t("signOutKeyCheck.title"),
      body: t("signOutKeyCheck.body"),
      cancel: t("signOutKeyCheck.cancel"),
      confirm: t("signOutKeyCheck.confirm"),
    }),
    [t],
  );

  return useSharedSignOutWithKeyCheck({
    holdsKey,
    signOut,
    text,
    log: (event) => console.info(`[parrot-sign-out] saved-key question: ${event}`),
  });
}
