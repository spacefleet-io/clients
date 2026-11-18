import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useAuth } from "../store/auth";
import { ticketLifecycle } from "../lib/metadata/runtime";

/**
 * Keeps the anonymous metadata-ticket reserve running while someone is signed in and the app is in the foreground
 * (META-ANON-02), and erases it on sign-out. Renders nothing; must sit inside <AuthProvider>.
 */
export const MetadataTicketsController = () => {
  const { token, loading } = useAuth();
  const startupChecked = useRef(false);

  useEffect(() => {
    ticketLifecycle.setSessionToken(token);
  }, [token]);

  useEffect(() => {
    // Once the stored session has been read: no session at cold start means no tickets may be left on the device
    // (an app killed in the middle of a sign-out never ran its erase, and the token goes null -> null on the next start).
    if (loading || startupChecked.current) return;
    startupChecked.current = true;
    if (token === null) ticketLifecycle.eraseWithoutSession();
  }, [loading, token]);

  useEffect(() => {
    ticketLifecycle.setForeground(AppState.currentState !== "background");
    const subscription = AppState.addEventListener("change", (state) => {
      ticketLifecycle.setForeground(state !== "background");
    });
    return () => subscription.remove();
  }, []);

  return null;
};
