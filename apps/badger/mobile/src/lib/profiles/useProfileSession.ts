import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useAuth } from "../../store/auth";
import type { ProfileGate } from "../../navigation/resolveScreen";
import { profileStore, useProfiles } from "./profileStore";

/**
 * Starts the account's profile session when someone is signed in and ends it at sign-out (UX-PROF-01, UX-PROF-02):
 * `askEveryStart` is true on TV, so the TV asks "Who's watching?" at every start of the app, while the phone reopens
 * the profile chosen at sign-in. The list is re-read when the app comes back to the foreground, so a profile deleted
 * on another device stops being used. Returns the navigator's gate.
 */
export const useProfileSession = (askEveryStart: boolean): ProfileGate => {
  const { user, token, loading } = useAuth();
  const snapshot = useProfiles();
  const userId = user?.id ?? null;
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (userId && token) {
      lastUserId.current = userId;
      void profileStore.startSession({ userId, token, askEveryStart });
      return;
    }
    if (lastUserId.current) {
      const previous = lastUserId.current;
      lastUserId.current = null;
      void profileStore.endSession(previous);
    }
  }, [askEveryStart, loading, token, userId]);

  useEffect(() => {
    if (!userId) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void profileStore.refresh();
    });
    return () => subscription.remove();
  }, [userId]);

  if (!userId) return "ready";
  if (snapshot.userId !== userId || snapshot.status === "loading") return "loading";
  return snapshot.needsChoice ? "choose" : "ready";
};
