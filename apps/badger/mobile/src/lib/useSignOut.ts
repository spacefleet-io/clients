import { useCallback } from "react";
import { useMobileSignOut } from "@space/mobile-shell/sign-out";
import { useAuth } from "../store/auth";
import { getStoredLibraryKey } from "./onboarding";

/**
 * The phone's Sign out (ACCT-DEV-03, `useMobileSignOut`): a phone that holds the library key first asks whether it
 * was saved, a phone without one signs out at once.
 */
export const useSignOut = (): (() => Promise<void>) => {
  const { logout } = useAuth();
  const signOut = useCallback(() => logout("signOut"), [logout]);
  return useMobileSignOut({ readStoredKey: getStoredLibraryKey, signOut, keyPrefix: "account.signOutKey" });
};
