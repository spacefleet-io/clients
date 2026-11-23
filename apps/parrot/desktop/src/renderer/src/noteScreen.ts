import { useEffect } from "react";

/**
 * OPS-BIZ-20: one opened screen for the daily hello's tally each time `screen` changes (the hello itself is sent by
 * the main process). A bridge without the call (an older preload, a test double) counts nothing.
 */
export const useNoteScreen = (screen: string | null) => {
  useEffect(() => {
    if (screen === null || typeof window.parrot?.noteScreen !== "function") return;
    void window.parrot.noteScreen().catch(() => {});
  }, [screen]);
};
