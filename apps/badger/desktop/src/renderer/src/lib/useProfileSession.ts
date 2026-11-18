import { useEffect, useRef } from "react";
import { useAuth } from "@/auth";
import { handlePlaybackProfileRefused, profileStore } from "@/lib/profileStore";

/**
 * Starts the account's profile session when someone is signed in and ends it at sign-out (UX-PROF-01, UX-PROF-02).
 * Desktop asks "Who's watching?" at every start of the app (`askEveryStart`), as the TV does, and never saves the
 * choice. The list is re-read when the window regains focus, and at once when the server refuses the active profile on
 * a playback, so a profile deleted on another device stops being used.
 */
export const useProfileSession = () => {
  const { user, token, loading } = useAuth();
  const userId = user?.id ?? null;
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (userId && token) {
      lastUserId.current = userId;
      void profileStore.startSession({ userId, token, askEveryStart: true });
      return;
    }
    if (lastUserId.current) {
      const previous = lastUserId.current;
      lastUserId.current = null;
      void profileStore.endSession(previous);
    }
  }, [loading, token, userId]);

  useEffect(() => {
    if (!userId) return;
    const refresh = () => void profileStore.refresh();
    window.addEventListener("focus", refresh);
    const unsubscribeRefused = window.sf?.onPlaybackProfileRefused?.((code) => void handlePlaybackProfileRefused(code));
    return () => {
      window.removeEventListener("focus", refresh);
      unsubscribeRefused?.();
    };
  }, [userId]);
};
