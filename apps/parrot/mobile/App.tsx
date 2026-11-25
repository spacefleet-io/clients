// Parrot: the sign-in first, then the first setup (language, library key, your profile, notifications, error reports),
// then the four tabs (Home, Library, Playlists, Settings) on the starry sky, and play.
import { API_BASE_URL } from "./src/config";
import React, { useEffect, useRef, useState } from "react";
import { phoneSetupSignedOut, resolvePhoneSetupStep, type PhoneSetupProgress } from "@space/mobile-shell/setup";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { Platform, StatusBar, View } from "react-native";
import { createPendingPairLink } from "@space/mobile-shell/pairing-approve";
import { useHeldPairLink, usePairLinkIntake } from "@space/mobile-shell/pairing-approve/usePairLinks";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { keyValueHelloStore, noteHelloScreen, startDailyHello } from "@space/shared/dailyHello";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { createNavigationContainerRef, DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator, type NativeStackScreenProps } from "@react-navigation/native-stack";
import { MobileProfilesScreen } from "@space/mobile-shell/profiles-screen";
import type { ApiProfile } from "@space/shared/profiles";
import { activeProfileNeedsSetup, useUpdateFeatures } from "@space/mobile-shell/profile-setup";
import { ProfileSetupStep } from "@space/mobile-shell/profile-setup-step";
import { WhatsNewModal } from "@space/mobile-shell/whats-new";
import { parrotProfileMoves, profileStore, useProfiles } from "./src/lib/profiles";
import { stopPlayback } from "./src/lib/playback";
import { SessionProvider, useSession } from "./src/state/session";
import { LoginScreen } from "./src/screens/LoginScreen";
import { LibraryKeyScreen } from "./src/screens/LibraryKeyScreen";
import { MainScreen } from "./src/screens/MainScreen";
import { AlbumScreen } from "./src/screens/AlbumScreen";
import { ArtistScreen } from "./src/screens/ArtistScreen";
import { PlayerScreen } from "./src/screens/PlayerScreen";
import { PlaylistScreen } from "./src/screens/PlaylistScreen";
import { HistoryProvider } from "./src/state/history";
import { PlaylistEditorProvider } from "./src/state/playlistEditor";
import { ManageProvider } from "./src/state/manage";
import { PairDeviceScreen } from "./src/screens/PairDeviceScreen";
import { DeleteAccountScreen } from "./src/screens/DeleteAccountScreen";
import { OfflineContentScreen } from "./src/screens/OfflineContentScreen";
import { NowPlayingBar } from "./src/screens/NowPlayingBar";
import { SetupFlow } from "./src/setup/SetupFlow";
import { profileSetupLog } from "./src/setup/ProfileSetupQuestion";
import { setupStore } from "./src/lib/stores";
import type { RootStack } from "./src/screens/routes";
import { MobileShellThemeProvider } from "@space/mobile-shell/theme";
import { AccountLanguagePromptHost } from "@space/mobile-shell/account-language-prompt";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileUpdateRequiredScreen, useAppUpdateRequired } from "@space/mobile-shell/update-required";
import { SelfUpdateConsent, SelfUpdateDialog, startSelfUpdate } from "@space/mobile-self-update";
import { MobileSkyLayer, MobileSkyScreenLayout, mobileNavigationTheme } from "@space/mobile-shell/components";
import { colors, parrotShellTheme } from "./src/theme";
import { PARROT_MASCOT } from "./src/brand";
import { startI18n } from "./src/lib/i18n";
import { PARROT_LINK_SCHEME } from "./src/lib/linkScheme";
import { TvGates } from "./src/tv/TvGates";

// Started once at launch, before any screen reads a translated text (Settings may mount first, with a saved session).
const i18nStarted = startI18n();
// ACCT-PAIR-06: a pairing link held until the library's navigator is up (a cold start through the link, or signed out).
const pairLinks = createPendingPairLink();

const Stack = createNativeStackNavigator<RootStack>();
const navigationRef = createNavigationContainerRef<RootStack>();

// Transparent navigator: every screen and header shows the sky behind it (UX-SKY-04).
const theme = mobileNavigationTheme(DarkTheme, colors);

const profilesLog = (event: string, data: Record<string, unknown>) => console.info(`parrot.profiles.screen.${event}`, JSON.stringify(data));

/** "Who's listening?" opened from Settings: switch, or add, edit (name and avatar, ACCT-PROF-05) and delete (UX-PROF-01, ACCT-PROF-02). */
const ProfilesRoute = ({ navigation, route }: NativeStackScreenProps<RootStack, "Profiles">) => (
  <MobileProfilesScreen
    store={profileStore}
    moves={parrotProfileMoves}
    startMode={route.params.mode}
    audience="listening"
    onClose={() => navigation.goBack()}
    log={profilesLog}
  />
);

const Library = ({ profile }: { profile: ApiProfile | null }) => {
  const [route, setRoute] = useState<keyof RootStack>("Main");
  const { session } = useSession();
  const userId = session?.user.id ?? "";
  // Offline with no saved list: the account's own history, as before profiles.
  const owner = { userId, profileId: profile?.id ?? "main", isMain: profile?.isMain ?? true };
  // ACCT-PAIR-06: a pairing link held before this navigator existed, or one arriving now, opens the approve screen.
  const [navReady, setNavReady] = useState(false);
  useHeldPairLink(pairLinks, navReady, (code) => navigationRef.navigate("PairDevice", { code }));
  return (
    <HistoryProvider owner={owner}>
    <ManageProvider>
    <PlaylistEditorProvider>
    <View style={{ flex: 1 }}>
      <NavigationContainer
        ref={navigationRef}
        theme={theme}
        onReady={() => setNavReady(true)}
        onStateChange={() => {
          setRoute((navigationRef.getCurrentRoute()?.name as keyof RootStack) ?? "Main");
          // OPS-BIZ-20: each screen the navigator opens adds one to the daily hello's screen tally.
          noteHelloScreen();
        }}
      >
        <Stack.Navigator
          // UX-CRASH-01: a screen that throws shows Retry in its place; the rest of the app keeps running.
          // UX-SKY-04: every screen stands on the sky (a screen with its own `ParrotSky` takes it over).
          // The player paints its own sky and slides as a whole when dragged down (UX-SHEET-01), so none under it.
          screenLayout={({ children, route, navigation }) => (
            <MobileSkyScreenLayout navigation={navigation} sky={route.name !== "Player"}>
              <MobileRenderBoundary name={`screen:${route.name}`} resetKey={route.key}>
                {children}
              </MobileRenderBoundary>
            </MobileSkyScreenLayout>
          )}
          // No screen shows the navigator's header: each one draws its own top over the sky. A pushed page floats a
          // round back button (`PageBackButton`); a native header would paint a bar over the sky and, on iOS, wrap the
          // arrow in a clipped pill (UX-SKY-04).
          screenOptions={{ headerShown: false }}
        >
          {/* Home, Library, Playlists and Settings: each tab draws its own big title over the sky. */}
          <Stack.Screen name="Main" component={MainScreen} />
          <Stack.Screen name="Album" component={AlbumScreen} />
          <Stack.Screen name="Artist" component={ArtistScreen} />
          <Stack.Screen name="Playlist" component={PlaylistScreen} />
          {/* The player draws its own header (chevron down, "PLAYING FROM ALBUM", the menu), as in the design. */}
          {/* UX-SHEET-01: on Android it rises over the page it came from, which stays drawn behind it, so dragging it
              down shows that page (iOS's modal sheet does the same by itself). */}
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={Platform.OS === "android" ? { presentation: "transparentModal", animation: "slide_from_bottom" } : { presentation: "modal" }}
          />
          <Stack.Screen name="PairDevice" component={PairDeviceScreen} />
          <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} />
          <Stack.Screen name="OfflineContent" component={OfflineContentScreen} />
          {/* The shared profile screen draws its own title ("Who's listening?") and its Done. */}
          <Stack.Screen name="Profiles" component={ProfilesRoute} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* The Library tabs hold their own mini player, above the tab bar. */}
      {route !== "Player" && route !== "Main" ? <NowPlayingBar onOpen={() => navigationRef.isReady() && navigationRef.navigate("Player")} /> : null}
    </View>
    </PlaylistEditorProvider>
    </ManageProvider>
    </HistoryProvider>
  );
};

// The shell's theme with Parrot's mascot, shown over the setup card (UX-SETUP-08).
const SHELL_THEME = { ...parrotShellTheme, mascotSource: PARROT_MASCOT };

// The startup screen, before the stored session, the language and the setup are read: the nodding parrot (UX-WAIT-02).
const Spinner = () => (
  <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
    <MobileMascotLoader app="parrot" source={PARROT_MASCOT} size={120} />
  </View>
);

const Gates = () => {
  const { booting, session, libraryKey } = useSession();
  const [i18nReady, setI18nReady] = useState(false);
  const [setup, setSetup] = useState<PhoneSetupProgress | null>(null);
  // REL-CD-29: the API refused this build as too old (any call, sign-in included).
  const updateRequired = useAppUpdateRequired();
  useEffect(() => {
    void i18nStarted.finally(() => setI18nReady(true));
    // REL-UPD-06: a hand-installed APK checks our repository for a newer Parrot (nothing in other builds).
    void startSelfUpdate("parrot");
  }, []);
  // OPS-BIZ-20: the daily hello, once per local day, a few seconds after start, silent on failure.
  useEffect(() => startDailyHello({ baseUrl: API_BASE_URL, store: keyValueHelloStore(AsyncStorage) }), []);
  // Google, Apple and Microsoft sign-in (ACCT-SIGNIN-05): the browser comes back through `parrot://auth/provider`, as
  // the link that started the app or one that arrives while it runs; the sign-in screen takes it, held until it mounts.
  // A pairing link (ACCT-PAIR-06) is held until the library is up, then opens the approve screen.
  usePairLinkIntake(PARROT_LINK_SCHEME, pairLinks);
  useEffect(() => {
    if (booting) return;
    void setupStore.read().then((saved) => {
      // A phone signed in with its key from before the setup existed has nothing left to set up.
      const fresh = !saved.done && saved.step === "language" && saved.language === null;
      setSetup(fresh && session && libraryKey ? { ...saved, done: true } : saved);
    });
    // Read once, after the stored session is known.
  }, [booting]);
  // Signed out during the setup (Back from the key): the next sign-in settles the language again, before step 1.
  useEffect(() => {
    if (booting || session || !setup) return;
    const next = phoneSetupSignedOut(setup);
    if (next === setup) return;
    setSetup(next);
    void setupStore.write(next);
  }, [booting, session, setup]);
  // The update screen covers everything once the texts can be read: sign-in, setup, the profile pick and the library.
  if (updateRequired && i18nReady) return <MobileUpdateRequiredScreen app="parrot" />;
  if (booting || !i18nReady || !setup) return <Spinner />;
  const saveSetup = async (next: PhoneSetupProgress) => {
    setSetup(next);
    await setupStore.write(next);
  };
  // Android TV, Google TV, Fire TV and Apple TV (PAR-TV-01): the same app shows its TV screens.
  if (Platform.isTV) return <TvGates setup={setup} save={saveSetup} spinner={<Spinner />} />;
  // The same flow as Badger's phone (UX-SETUP-08): the language first, then the sign-in, then the numbered steps; a
  // sign-out comes back to the sign-in.
  const step = setup.done ? null : resolvePhoneSetupStep(setup, { hasKey: !!libraryKey, signedIn: !!session });
  if (step === "language") return <SetupFlow progress={{ ...setup, step }} save={saveSetup} />;
  if (!session) {
    return (
      <LoginScreen
        onPaired={setup.done ? undefined : () => saveSetup({ ...setup, pairedKey: true })}
        onBack={setup.done ? undefined : () => void saveSetup({ ...setup, step: "language" })}
      />
    );
  }
  if (step) {
    return (
      <SetupFlow
        progress={{ ...setup, step }}
        save={saveSetup}
      />
    );
  }
  // After setup, a key that is gone (a session the server rejected) is asked again.
  if (!libraryKey) return <LibraryKeyScreen />;
  return <ProfileGate />;
};

/**
 * "Who's listening?" after the setup and the key, before the library (UX-PROF-01): the phone keeps the pick, so it
 * asks once per sign-in, or when the kept profile is gone. A switch stops the song of the profile before.
 * A profile picked here that has not set up its name and avatar gets "Your profile" alone, without a count
 * (UX-SETUP-10); one made before the avatars gets the "New in this update" window over the library (UX-UPDATE-01),
 * whose "Choose my avatar" opens the same step, Back returning to the window.
 */
const ProfileGate = () => {
  const profiles = useProfiles();
  const active = profiles.profiles.find((profile) => profile.id === profiles.activeId) ?? null;
  const activeId = active?.id ?? null;
  const previous = useRef(activeId);
  const updates = useUpdateFeatures(profiles.needsChoice ? null : active);
  useEffect(() => {
    if (previous.current && activeId && previous.current !== activeId) void stopPlayback();
    previous.current = activeId ?? previous.current;
  }, [activeId]);
  if (profiles.status !== "ready") return <Spinner />;
  if (profiles.needsChoice) {
    return (
      <MobileProfilesScreen
        store={profileStore}
        moves={parrotProfileMoves}
        startMode="pick"
        audience="listening"
        onClose={null}
        log={profilesLog}
      />
    );
  }
  if (active && (updates.settingUp || activeProfileNeedsSetup(profiles))) {
    // Next saves `features.avatars = "set"`: the store's new snapshot moves on to the library by itself.
    return (
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <ProfileSetupStep
          key={active.id}
          profile={active}
          onBack={updates.settingUp ? updates.back : undefined}
          onDone={() => profileSetupLog("done", { profileId: active.id, fromWindow: !!updates.settingUp })}
          log={profileSetupLog}
        />
      </SafeAreaView>
    );
  }
  const feature = active ? updates.current : null;
  return (
    <>
      <Library profile={active} />
      {active && feature ? (
        <WhatsNewModal
          feature={feature}
          profileName={active.name}
          onChoose={() => updates.setUp(feature)}
          onLater={() => void updates.later(feature)}
        />
      ) : null}
    </>
  );
};

// The shared mobile-shell pieces (sign-in mascot, feedback form) take Parrot's green from this theme.
const App = () => (
  <MobileShellThemeProvider value={SHELL_THEME}>
    {/* UX-CRASH-01: the last guard; a crash outside every screen (sign-in, setup, providers) shows the sign-in screen's
        sky and mascot with one "Try again" button. */}
    <MobileRenderBoundary name="window" variant="window" mascotSource={PARROT_MASCOT}>
    <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["bottom"]}>
        {/* UX-SKY-04: the sky under sign-in, setup, the key and the profile pick, never a black page. */}
        <MobileSkyLayer>
          <SessionProvider>
            <Gates />
          </SessionProvider>
          {/* UX-I18N-07: "Which language do you want?" right after a sign-in whose account speaks another language. */}
          <AccountLanguagePromptHost />
          {/* REL-UPD-06: "Keep Parrot up to date?" once on a hand install, then the update dialog. */}
          <SelfUpdateConsent />
          <SelfUpdateDialog />
        </MobileSkyLayer>
      </SafeAreaView>
    </SafeAreaProvider>
    </GestureHandlerRootView>
    </MobileRenderBoundary>
  </MobileShellThemeProvider>
);

export default App;
