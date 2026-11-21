// The phone's four tabs (PAR-NAV-02, PAR-LOOK-01): Home, Library, Playlists and Settings on the fleet's shared bottom
// tab bar over Parrot's sky, with the floating mini player just above the bar while a song is queued. Home opens first
// (PAR-HOME-01); its rows' "See all" open the Library tab on the album list (in "Recently added" order from that row) or
// the artist list. While the library holds no
// album, the Library and Playlists tabs are greyed out and open nothing, as on Badger's phone (UX-LIBTAB-01). A swipe left or right
// moves between the open tabs (UX-PHONE-09, the shared `MobileTabPager`). The tab pages have no page
// title: the bar's selected tab names the page (PAR-NAV-04). The status-bar inset is applied here, once for every tab.
// The bar's centre Search button, between Library and Playlists, is not a tab (UX-PHONE-12): it opens the search card
// over the page, and a swipe goes from Library straight to Playlists.
import React, { useCallback, useEffect, useState } from "react";
import type { ParrotAlbumSort } from "@space/parrot-core";
import { StyleSheet, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { House, LibraryBig, ListMusic, Search, Settings } from "lucide-react-native";
import { MobileTabBar, type MobileTabBarAction, type MobileTabDefinition } from "@space/mobile-shell/tab-bar";
import { MobileFounderNoticeHost, MobileTabPager } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { HomeScreen } from "./HomeScreen";
import { LibraryScreen, type LibraryRequest, type LibraryView } from "./LibraryScreen";
import { PlaylistsView } from "./PlaylistsView";
import { SettingsScreen } from "./SettingsScreen";
import { NowPlayingBar } from "./NowPlayingBar";
import { PhoneSearch } from "./PhoneSearch";
import { ParrotSky } from "./sky";
import type { RootStack } from "./routes";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { listAlbums } from "../lib/library";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";

export type MainTab = "home" | "library" | "playlists" | "settings";

/**
 * The tabs, in order: the desktop's sidebar entries (`shell.nav.*`, shared strings), except Library and the phone's own
 * tab-bar words (`parrot.nav.playlistsTab`, `parrot.nav.settingsTab`: Dutch "Playlists" and "Opties", German "Optionen"),
 * short enough that each half of the bar beside the Search button holds its two labels on a 360 dp phone (UX-PHONE-12).
 */
export const MAIN_TABS: ReadonlyArray<{ id: MainTab; label: string; icon: MobileTabDefinition["icon"] }> = [
  { id: "home", label: "shell.nav.home", icon: House },
  { id: "library", label: "parrot.nav.library", icon: LibraryBig },
  { id: "playlists", label: "parrot.nav.playlistsTab", icon: ListMusic },
  { id: "settings", label: "parrot.nav.settingsTab", icon: Settings },
];
const TAB_IDS = MAIN_TABS.map((entry) => entry.id);
const DISABLED_WITHOUT_LIBRARY: MainTab[] = ["library", "playlists"];
const OPEN_WITHOUT_LIBRARY = TAB_IDS.filter((id) => !DISABLED_WITHOUT_LIBRARY.includes(id));

export const MainScreen = ({ navigation }: NativeStackScreenProps<RootStack, "Main">) => {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<MainTab>("home");
  const [libraryRequest, setLibraryRequest] = useState<LibraryRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
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
    (view: LibraryView, albumSort?: ParrotAlbumSort) => {
      if (libraryClosed) return;
      setLibraryRequest({ view, albumSort });
      setTab("library");
    },
    [libraryClosed]
  );
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const searchAction: MobileTabBarAction = {
    id: "search",
    label: phoneSearchStrings("parrot", i18n.language).button,
    icon: Search,
    after: "library",
    disabled: libraryClosed,
    onPress: () => setSearchOpen(true),
  };
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
        action={searchAction}
      />
      <PhoneSearch visible={searchOpen} onClose={closeSearch} />
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
