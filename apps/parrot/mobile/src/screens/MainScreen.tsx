// The phone's four tabs (PAR-NAV-02, PAR-LOOK-01): Home, Library, Playlists and Settings on the fleet's shared bottom
// tab bar over Parrot's sky, with the floating mini player just above the bar while a song is queued. Home opens first
// (PAR-HOME-01); its rows' "See all" open the Library tab on the album or the artist list. While the library holds no
// album, the Library and Playlists tabs are greyed out and open nothing, as on Badger's phone (UX-LIBTAB-01). A swipe left or right
// moves between the open tabs (UX-PHONE-09, the shared `MobileTabPager`). The tab pages have no page
// title: the bar's selected tab names the page (PAR-NAV-04). The status-bar inset is applied here, once for every tab.
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { House, LibraryBig, ListMusic, Settings } from "lucide-react-native";
import { MobileTabBar, type MobileTabDefinition } from "@space/mobile-shell/tab-bar";
import { MobileFounderNoticeHost, MobileTabPager } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { HomeScreen } from "./HomeScreen";
import { LibraryScreen, type LibraryView } from "./LibraryScreen";
import { PlaylistsView } from "./PlaylistsView";
import { SettingsScreen } from "./SettingsScreen";
import { NowPlayingBar } from "./NowPlayingBar";
import { ParrotSky } from "./sky";
import type { RootStack } from "./routes";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { listAlbums } from "../lib/library";

export type MainTab = "home" | "library" | "playlists" | "settings";

/** The tabs, in order: the desktop's sidebar entries (`shell.nav.*`, shared strings). */
export const MAIN_TABS: ReadonlyArray<{ id: MainTab; label: string; icon: MobileTabDefinition["icon"] }> = [
  { id: "home", label: "shell.nav.home", icon: House },
  { id: "library", label: "parrot.nav.library", icon: LibraryBig },
  { id: "playlists", label: "shell.nav.playlists", icon: ListMusic },
  { id: "settings", label: "shell.nav.settings", icon: Settings },
];
const TAB_IDS = MAIN_TABS.map((entry) => entry.id);
const DISABLED_WITHOUT_LIBRARY: MainTab[] = ["library", "playlists"];
const OPEN_WITHOUT_LIBRARY = TAB_IDS.filter((id) => !DISABLED_WITHOUT_LIBRARY.includes(id));

export const MainScreen = ({ navigation }: NativeStackScreenProps<RootStack, "Main">) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<MainTab>("home");
  const [libraryRequest, setLibraryRequest] = useState<{ view: LibraryView } | null>(null);
  const { library, session } = useSession();
  const isFocused = useIsFocused();
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => (version < 0 ? Promise.resolve(null) : listAlbums()), [version]);
  // Empty only once known (UX-WAIT-04): no library on this account, or an opened one whose album list, read for this
  // version, holds no album. Loading, or the answer of an older version, keeps the tab open.
  const libraryClosed = library.status === "missing" || (library.status === "ready" && albums.answered && albums.data?.length === 0);
  useEffect(() => {
    if (!libraryClosed) return;
    console.info("[parrot-nav] library empty: back to home");
    setTab((current) => (DISABLED_WITHOUT_LIBRARY.includes(current) ? "home" : current));
  }, [libraryClosed]);
  const tabs = MAIN_TABS.map((entry) => ({ ...entry, label: t(entry.label) }));
  const changeTab = useCallback((id: string) => setTab(id as MainTab), []);
  const seeAll = useCallback(
    (view: LibraryView) => {
      if (libraryClosed) return;
      setLibraryRequest({ view });
      setTab("library");
    },
    [libraryClosed]
  );
  return (
    <ParrotSky>
      <View style={[styles.content, { paddingTop: insets.top }]}>
        {/* A swipe left or right moves between the tabs, as on Badger's phone (UX-PHONE-09). */}
        <MobileTabPager tabIds={libraryClosed ? OPEN_WITHOUT_LIBRARY : TAB_IDS} activeTab={tab} onTabChange={changeTab}>
          {(id) =>
            id === "home" ? (
              <HomeScreen onSeeAll={seeAll} />
            ) : id === "library" ? (
              <LibraryScreen active={tab === "library"} viewRequest={libraryRequest} />
            ) : id === "playlists" ? (
              <PlaylistsView />
            ) : (
              <SettingsScreen />
            )
          }
        </MobileTabPager>
      </View>
      <NowPlayingBar onOpen={() => navigation.navigate("Player")} />
      {/* In the layout flow, not over the lists: the mini player sits on top of it. The app's safe area already keeps it
          above Android's navigation bar. */}
      <MobileTabBar
        tabs={tabs}
        activeTab={tab}
        onTabChange={changeTab}
        disabledTabs={libraryClosed ? DISABLED_WITHOUT_LIBRARY : undefined}
        style={styles.tabBar}
      />
      {/* WAIT-FOUND-04 / UX-NOTICE-01: the one-time "Founder ticket recognised" notice floats over the page, as on
          Badger's phone; tapping it opens Settings, where the badge is. While the player covers this screen it waits. */}
      <MobileFounderNoticeHost token={session?.token} held={!isFocused} onOpen={() => setTab("settings")} />
    </ParrotSky>
  );
};

const styles = StyleSheet.create({
  content: { flex: 1 },
  tabBar: { position: "relative", paddingBottom: 10 },
});
