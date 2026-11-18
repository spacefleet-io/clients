import { useEffect, useMemo } from "react";
import { useTVEventHandler } from "react-native";
import type { SkyCoverRegistry } from "./mobile-sky-covers";
import { createSkyRemoteInput } from "./mobile-sky-remote-input";

/**
 * Every TV remote key holds the screen's sky still, like a tap on the phone (UX-SKY-01), while `active` (the
 * screen is the one on top). A phone sends no remote events, so this does nothing there.
 */
export const useSkyRemoteInput = (covers: Pick<SkyCoverRegistry, "scrollBegan" | "scrollEnded">, active = true) => {
  const remoteInput = useMemo(() => createSkyRemoteInput(covers), [covers]);
  useEffect(() => () => remoteInput.dispose(), [remoteInput]);
  useTVEventHandler(() => {
    if (active) remoteInput.noteKey();
  });
};
