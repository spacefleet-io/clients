// Parrot TV's main shell (PAR-TV-01, PAR-TV-03, PAR-TV-10): the family's TV top bar (Badger TV's, UX-TV-09) with
// Parrot's mark and music-list Playlists icon over the night sky, and the open section under it. Back on a section
// other than Home returns to Home; on Home it leaves the app as usual.
import React, { useEffect, useState } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { ListMusic } from "lucide-react-native";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvSky } from "@space/mobile-shell/tv/TvSky";
import { TvTopBar } from "@space/mobile-shell/tv/TvTopBar";
import { setCurrentTvSection, subscribeTvSectionRequest, type TvSectionId } from "@space/mobile-shell/tv/tvSection";
import { useTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";
import { PARROT_TV_ICON } from "../brand";

const log = scopeLogger("parrot.tv.shell");

/** The open section's page under the bar; the screens are filled section by section (PAR-TV-03, PAR-TV-13). */
export type TvSectionPages = Partial<Record<TvSectionId, React.ReactNode>>;

export const TvMainShell = ({ pages = {} }: { pages?: TvSectionPages }) => {
  const [active, setActive] = useState<TvSectionId>("home");

  // A page opened from here names this section on its Back button (UX-TV-06), and a tab picked there opens it here.
  useEffect(() => {
    setCurrentTvSection(active);
    log.info("section", { section: active });
  }, [active]);
  useEffect(() => subscribeTvSectionRequest(setActive), []);

  // PAR-TV-10: Back on a section other than Home returns to Home; on Home the system has it (the app leaves).
  const backHandled = active !== "home";
  useEffect(() => {
    if (!backHandled) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      log.info("back_to_home", { from: active });
      setActive("home");
      return true;
    });
    return () => subscription.remove();
  }, [active, backHandled]);
  // Apple TV delivers Menu to the handler above only while the key is held; on Home the system keeps it (-> Apple TV home).
  useTvMenuKeyHold("tv-tab", backHandled);

  return (
    <TvSky active>
      <View style={styles.shell} testID="parrot-tv-shell">
        <TvTopBar brandIcon={PARROT_TV_ICON} playlistsIcon={ListMusic} active={active} onSelect={setActive} />
        <View style={styles.content} testID={`parrot-tv-section-${active}`}>
          {pages[active] ?? null}
        </View>
      </View>
    </TvSky>
  );
};

const styles = StyleSheet.create({
  shell: { flex: 1 },
  content: { flex: 1 },
});
