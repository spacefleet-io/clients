import React, { Suspense, useEffect, useState } from "react";
import { DarkTheme, NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../store/auth";
import { useLibraryStatus } from "../store/library";
import { MobileUpdateRequiredScreen, useAppUpdateRequired } from "@space/mobile-shell/update-required";
import { translate, useTranslation } from "@space/mobile-shell/i18n";
import { LoginScreen } from "../screens/LoginScreen";
import { OnboardingKeyScreen } from "../screens/OnboardingKeyScreen";
import { ErrorReportsScreen } from "../screens/ErrorReportsScreen";
import { TitleLanguageScreen } from "../setup/TitleLanguageQuestion";
import { useTitleLanguageQuestion } from "../lib/titleLanguageQuestion";
import { ProfileSetupScreen } from "../setup/ProfileSetupQuestion";
import { useBadgerUpdateFeatures, useProfileSetupQuestion } from "../lib/profileSetupQuestion";
import { WhatsNewModal } from "@space/mobile-shell/whats-new";
import { TvWhatsNewWindow } from "../tv/screens/TvWhatsNewWindow";
import type { AppFeatureId } from "@space/shared/appFeatures";
import { BadgerSetupFlow } from "../setup/BadgerSetupFlow";
import { usePhoneSetup } from "../setup/phoneSetupStore";
import { resolvePhoneSetupStep } from "@space/mobile-shell/setup";
import { useAppSettings } from "../lib/appSettings";
import { MainShellScreen } from "../screens/MainShellScreen";
import { LibraryFormatTooNewScreen } from "../screens/LibraryFormatTooNewScreen";
import { AppLoadingScreen } from "./AppLoadingScreen";
// Secondary screens eagerly imported — RN 0.85 + Hermes in dev mode rejects
// Metro's lazy-chunk format ("Parsing source code unsupported: __d(function
// (global, _$$_REQUIR…)") when React.lazy() triggers loadBundleFromServer.
// See lazy_screen.error in logcat. Re-enable lazy once the Metro/Hermes
// compat is resolved (Metro >0.84 may emit a parseable chunk format).
import { MediaDetailsScreen } from "../screens/MediaDetailsScreen";
import { PlayerScreen } from "../screens/PlayerScreen";
import { PairSignInScreen } from "../screens/PairSignInScreen";
import { CastScreen } from "../screens/cast/CastScreen";
import type { CastTarget } from "../lib/cast/castFlow";
import { PlaylistDetailScreen } from "../screens/PlaylistDetailScreen";
import { ResetKeyScreen } from "../screens/ResetKeyScreen";
import { PairDeviceScreen } from "../screens/PairDeviceScreen";
import { parseLegacyPairLink, parsePairLink } from "@space/pairing-crypto";
import { handOffProviderReturn } from "@space/mobile-shell/provider-sign-in";
import { BADGER_LINK_SCHEME } from "../lib/linkScheme";
import { DownloadsScreen } from "../screens/DownloadsScreen";
import { OfflineContentScreen } from "../screens/OfflineContentScreen";
import { useDownloadsBootstrap } from "../lib/downloads/useDownloadsBootstrap";
import { useAccountLanguageSync } from "../lib/useAccountLanguageSync";
import { SubscriptionScreen } from "../screens/SubscriptionScreen";
import { DeleteAccountScreen } from "../screens/DeleteAccountScreen";
import { FeedbackScreen } from "../screens/FeedbackScreen";
import { theme } from "../theme/theme";
import { scopeLogger } from "@space/mobile-shell/logger";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileSkyScreenLayout, mobileNavigationTheme } from "@space/mobile-shell/components";

import { TvRemoteScreen } from "../screens/TvRemoteScreen";
import { usePlayOnTvReceiver } from "../tv/lib/usePlayOnTvReceiver";
import type { RemoteStart, StartCommand } from "../lib/playOnTv/protocol";
import { TvMainShell } from "../tv/screens/TvMainShell";
import { TvMediaDetailsScreen } from "../tv/screens/TvMediaDetailsScreen";
import { TvSignInScreen } from "../tv/screens/TvSignInScreen";
import { TvLanguageScreen } from "../tv/screens/TvLanguageScreen";
import { useTvSetup } from "../tv/lib/tvSetupStore";
import { tvLanguagePending } from "../tv/lib/tvSetup";
import { TvApprovePairingScreen } from "../tv/screens/TvApprovePairingScreen";
import { TvProfilesScreen } from "../tv/screens/TvProfilesScreen";
import { ProfilesScreen } from "../screens/ProfilesScreen";
import { useProfileSession } from "../lib/profiles/useProfileSession";
import { IS_TV, routeAvailable } from "../tv/lib/tvRuntime";
import { stackHasScreenToPop } from "@space/mobile-shell/tv/menuKey";
import { setTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";
const log = scopeLogger("pairing.link");

const ScreenSuspenseFallback = () => (
  <View style={styles.loadingWrap}>
    <ActivityIndicator />
  </View>
);

class LazyScreenErrorBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn(
      "lazy_screen.error",
      JSON.stringify({ name: this.props.name, message: error.message })
    );
  }

  retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.loadingWrap}>
            <Text style={styles.errorTitle}>{translate("nav.screenLoadFailed")}</Text>
            <Text style={styles.errorText}>{this.state.error.message}</Text>
            <Pressable style={styles.retryButton} onPress={this.retry}>
              <Text style={styles.retryButtonLabel}>{translate("nav.tryAgain")}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

const withSuspense = <P extends object>(
  Component: React.ComponentType<P>,
  name: string,
) => {
  const Wrapped = (props: P) => (
    <LazyScreenErrorBoundary name={name}>
      <Suspense fallback={<ScreenSuspenseFallback />}>
        <Component {...props} />
      </Suspense>
    </LazyScreenErrorBoundary>
  );
  Wrapped.displayName = `Lazy(${name})`;
  return Wrapped;
};

const MediaDetailsScreenLazy = withSuspense(MediaDetailsScreen, "MediaDetailsScreen");
const PlayerScreenLazy = withSuspense(PlayerScreen, "PlayerScreen");
const CastScreenLazy = withSuspense(CastScreen, "CastScreen");
const PlaylistDetailScreenLazy = withSuspense(PlaylistDetailScreen, "PlaylistDetailScreen");
const SubscriptionScreenLazy = withSuspense(SubscriptionScreen, "SubscriptionScreen");
const DeleteAccountScreenLazy = withSuspense(DeleteAccountScreen, "DeleteAccountScreen");
const ResetKeyScreenLazy = withSuspense(ResetKeyScreen, "ResetKeyScreen");
const DownloadsScreenLazy = withSuspense(DownloadsScreen, "DownloadsScreen");
const OfflineContentScreenLazy = withSuspense(OfflineContentScreen, "OfflineContentScreen");

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Transparent screens, cards and headers over the sky (UX-SKY-04). */
const navigationTheme = mobileNavigationTheme(DarkTheme, theme.colors);


export type RootStackParamList = {
  Auth: undefined;
  PairSignIn: undefined;
  /** Badger phone's setup walkthrough (UX-SETUP-03): language, notifications, error reports. */
  Setup: undefined;
  /** Badger TV's "Choose your language" before its sign-in (UX-SETUP-08 step 0). */
  TvLanguage: undefined;
  Onboarding: undefined;
  OnboardingReports: undefined;
  /** "How should titles appear?" on its own, right after a profile that never answered is picked (ACCT-PROF-03). */
  TitleLanguage: undefined;
  /** "Your profile" on its own (UX-SETUP-10), or opened from the update window's "Choose my avatar" (UX-UPDATE-01). */
  ProfileSetup: undefined;
  Main: undefined;
  MediaDetails: { mediaId: string };
  /** `remoteStart`: opened by "Play on TV" from the phone (UX-TV-02): start there, no resume prompt, apply those tracks. */
  Player: {
    mediaId: string;
    episodeId?: string | null;
    backdropPath?: string | null;
    posterPath?: string | null;
    remoteStart?: RemoteStart | null;
    /** The TV Home's Resume / Start over (UX-TV-05): start there without the resume prompt. */
    startAt?: "resume" | "startOver" | null;
  };
  Cast: { mediaId: string; episodeId?: string | null; target: CastTarget };
  /** Phone only: the remote of a title started on a TV app ("Play on TV", UX-TV-02). */
  TvRemote: { tvPeerId: string; tvName: string; title: string; start: StartCommand; posterPath?: string | null };
  PlaylistDetail: { playlistId: string; title: string };
  Subscription: undefined;
  DeleteAccount: undefined;
  /** Phone only: "Send feedback" (UX-SUP-05). */
  Feedback: undefined;
  ResetKey: undefined;
  /** `code` comes from the pairing link (ACCT-PAIR-06); absent when opened from Settings. */
  PairDevice: { code?: string };
  Downloads: undefined;
  /** Phone only: Settings › "Manage offline content" (OFFL-MANAGE-01). */
  OfflineContent: undefined;
  /** "Who's watching?" at start (UX-PROF-01/02): the gate before the app opens. */
  Profiles: undefined;
  /** The same screen opened from Settings: switch profile (`pick`) or add / rename / delete (`manage`). */
  SwitchProfile: { mode: "pick" | "manage" };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export { resolveNavigatorScreen, type NavigatorScreen } from "./resolveScreen";
import { resolveNavigatorScreen } from "./resolveScreen";

export const AppNavigator = () => {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const { needsKey, initializing, datasetStatus, contractIssue, formatTooNew, error } =
    useLibraryStatus();
  const [{ errorReportsDecided }] = useAppSettings();
  useDownloadsBootstrap();
  useAccountLanguageSync();
  const profileGate = useProfileSession(IS_TV);
  // Badger phone's setup (UX-SETUP-03); the TV keeps its own gates (UX-SETUP-04) after its language step (UX-SETUP-08).
  const setupProgress = usePhoneSetup(!IS_TV);
  const tvSetup = useTvSetup(IS_TV, { signedIn: !!user, loading });
  // REL-CD-29: the API refused this build as too old (any call, sign-in included).
  const updateRequired = useAppUpdateRequired();
  // ACCT-PROF-03: a profile created since the question exists that never answered it.
  const titleLanguageQuestion = useTitleLanguageQuestion();
  // UX-SETUP-10: the profile picked never set up its name and avatar.
  const profileSetupQuestion = useProfileSetupQuestion();
  // UX-UPDATE-01: an older profile's "New in this update" windows (the resolver shows them once every gate is passed).
  const updates = useBadgerUpdateFeatures(!!user && profileGate === "ready");

  const screen = resolveNavigatorScreen({
    updateRequired: updateRequired !== null,
    // The phone waits for its saved setup progress, so a set-up phone never flashes the first setup screen; the TV
    // waits for its own, so a TV that chose its language never flashes the language step.
    authLoading: loading || (!IS_TV && setupProgress === null) || (IS_TV && tvSetup === null),
    user,
    contractIssue,
    formatTooNew: formatTooNew !== null,
    needsKey,
    errorReportsAnswered: errorReportsDecided,
    initializing,
    datasetStatus,
    profiles: profileGate,
    setup:
      IS_TV || !setupProgress
        ? undefined
        : {
            done: setupProgress.done,
            step: resolvePhoneSetupStep(setupProgress, { hasKey: !needsKey, signedIn: !!user }),
            languageReconciled: setupProgress.languageReconciled,
          },
    tvLanguagePending: IS_TV && tvSetup !== null && tvLanguagePending(tvSetup),
    titleLanguageQuestion,
    profileSetupQuestion,
    updateSetUp: updates.settingUp !== null,
    updateWindow: updates.current !== null,
  });
  // TV: reachable for "Play on TV" from the phone while signed in and the library is open (UX-TV-02).
  usePlayOnTvReceiver(IS_TV && screen === "main");

  // https://spacefleet.io/pair/badger?code=ABCDEFGH (ACCT-PAIR-06: a QR scanned with the system camera, or a tapped
  // link) opens the pairing flow. The code is held until the user is signed in and the navigator is ready.
  // spacebadger://auth/provider?... (the browser back from Google, Apple or Microsoft, ACCT-SIGNIN-05) goes to the
  // sign-in screen, which may mount after a cold start through that link.
  const [pendingPairCode, setPendingPairCode] = useState<string | null>(null);
  const [navReady, setNavReady] = useState(false);
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (handOffProviderReturn(BADGER_LINK_SCHEME, url)) return;
      if (!url) return;
      // spacebadger://pair?code= is the QR of desktops released before the web link (ACCT-PAIR-06): kept until
      // those desktops are below the minimum supported version (REL-CD-08).
      const link = parsePairLink(url);
      const code = link?.code ?? parseLegacyPairLink(url);
      if (!code) return;
      log.warn("deep_link", { app: link?.app ?? "legacy" });
      setPendingPairCode(code);
    };
    void Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener("url", (event) => handle(event.url));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (screen !== "main" || !pendingPairCode || !navReady || !navigationRef.isReady()) return;
    navigationRef.navigate("PairDevice", { code: pendingPairCode });
    setPendingPairCode(null);
  }, [screen, pendingPairCode, navReady]);

  if (screen === "loading") {
    return <AppLoadingScreen label={t("nav.loading")} />;
  }

  if (screen === "contract-error") {
    // REL-CD-29: the refusal shows the screen shared with Parrot; an incompatible library contract keeps its message.
    if (updateRequired) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <MobileUpdateRequiredScreen app="badger" />
        </SafeAreaView>
      );
    }
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingWrap}>
          <Text style={styles.errorTitle}>{t("nav.updateRequired")}</Text>
          <Text style={styles.errorText}>{error ?? t("nav.unavailable", { issue: contractIssue })}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === "format-too-new") {
    return <LibraryFormatTooNewScreen />;
  }

  if (screen === "loading-library") {
    return <AppLoadingScreen label={t("nav.loadingLibrary")} />;
  }

  // Apple TV: Menu is only delivered as Back (react-navigation pops the stack) while a screen sits below the focused
  // one; on the first screen the system keeps it and returns to the Apple TV home screen.
  function syncTvStackMenuKey() {
    if (!IS_TV) return;
    setTvMenuKeyHold("stack", stackHasScreenToPop(navigationRef.getRootState()?.routes.length ?? 0));
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      onReady={() => {
        setNavReady(true);
        syncTvStackMenuKey();
      }}
      onStateChange={syncTvStackMenuKey}
    >
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        // UX-SKY-04: every screen over the desktop's sky, except the phone's details sheet (it shows the page below
        // through its scrim and draws its own) and the player (black behind the video).
        // UX-CRASH-01: a screen that throws shows Retry in its place; the rest of the app keeps running.
        screenLayout={({ children, route, navigation }) => (
          <MobileSkyScreenLayout navigation={navigation} sky={!(route.name === "Player" || (route.name === "MediaDetails" && !IS_TV))}>
            <MobileRenderBoundary name={`screen:${route.name}`} resetKey={route.key}>
              {children}
            </MobileRenderBoundary>
          </MobileSkyScreenLayout>
        )}
      >
        {screen === "setup" ? (
          <Stack.Screen name="Setup" component={BadgerSetupFlow} />
        ) : screen === "tv-language" ? (
          <Stack.Screen name="TvLanguage" component={TvLanguageScreen} />
        ) : screen === "auth" ? (
          <>
            <Stack.Screen name="Auth" component={IS_TV ? TvSignInScreen : LoginScreen} />
            {IS_TV ? null : <Stack.Screen name="PairSignIn" component={PairSignInScreen} />}
          </>
        ) : screen === "onboarding" ? (
          <Stack.Screen name="Onboarding" component={OnboardingKeyScreen} />
        ) : screen === "onboarding-reports" ? (
          <Stack.Screen name="OnboardingReports" component={ErrorReportsScreen} />
        ) : screen === "title-language" ? (
          <Stack.Screen name="TitleLanguage" component={TitleLanguageScreen} />
        ) : screen === "profile-setup" ? (
          <Stack.Screen name="ProfileSetup">{() => <ProfileSetupScreen onBack={updates.settingUp ? updates.back : undefined} />}</Stack.Screen>
        ) : screen === "profiles" ? (
          <Stack.Screen name="Profiles" component={IS_TV ? TvProfilesScreen : ProfilesScreen} />
        ) : (
          <>
            <Stack.Screen name="Main" component={IS_TV ? TvMainShell : MainShellScreen} />
            {IS_TV ? (
              // Without the phone sheet's pan-to-dismiss: the remote's Back key closes it. Its sky layer hides Main.
              <Stack.Screen name="MediaDetails" component={TvMediaDetailsScreen} />
            ) : (
              <Stack.Screen
                name="MediaDetails"
                component={MediaDetailsScreenLazy}
                options={{
                  presentation: "transparentModal",
                  animation: "none",
                  contentStyle: { backgroundColor: "transparent" },
                }}
              />
            )}
            <Stack.Screen name="PlaylistDetail" component={PlaylistDetailScreenLazy} />
            {routeAvailable("Subscription") ? <Stack.Screen name="Subscription" component={SubscriptionScreenLazy} /> : null}
            {IS_TV ? null : <Stack.Screen name="DeleteAccount" component={DeleteAccountScreenLazy} />}
            {IS_TV ? null : <Stack.Screen name="Feedback" component={FeedbackScreen} />}
            {IS_TV ? null : <Stack.Screen name="TvRemote" component={TvRemoteScreen} />}
            {/* iOS: hide the home indicator during full-screen playback (reappears on touch). */}
            <Stack.Screen name="Player" component={PlayerScreenLazy} options={{ autoHideHomeIndicator: true }} />
            <Stack.Screen name="Cast" component={CastScreenLazy} />
            <Stack.Screen name="ResetKey" component={ResetKeyScreenLazy} />
            {/* TV: no camera, the approver types the code and proves the account password (ACCT-PAIR-02). */}
            <Stack.Screen name="PairDevice" component={IS_TV ? TvApprovePairingScreen : PairDeviceScreen} />
            {routeAvailable("Downloads") ? <Stack.Screen name="Downloads" component={DownloadsScreenLazy} /> : null}
            {routeAvailable("OfflineContent") ? <Stack.Screen name="OfflineContent" component={OfflineContentScreenLazy} /> : null}
            <Stack.Screen name="SwitchProfile" component={IS_TV ? TvProfilesScreen : ProfilesScreen} />
          </>
        )}
      </Stack.Navigator>
      {screen === "whats-new" && updates.current && updates.profile ? (
        <UpdateWindow feature={updates.current} profileName={updates.profile.name} onChoose={updates.setUp} onLater={updates.later} />
      ) : null}
    </NavigationContainer>
  );
};

/**
 * "New in this update" (UX-UPDATE-01) over the app, which stays mounted and dimmed underneath: the phone's window
 * (`phone-modal.png`), the TV's own (`TvWhatsNewWindow`, which draws its scrim and keeps the remote in its card).
 */
const UpdateWindow = ({
  feature,
  profileName,
  onChoose,
  onLater,
}: {
  feature: AppFeatureId;
  profileName: string;
  onChoose: (feature: AppFeatureId) => void;
  onLater: (feature: AppFeatureId) => Promise<void>;
}) =>
  IS_TV ? (
    <View style={StyleSheet.absoluteFill}>
      <TvWhatsNewWindow feature={feature} profileName={profileName} onChoose={() => onChoose(feature)} onLater={() => void onLater(feature)} />
    </View>
  ) : (
    <WhatsNewModal feature={feature} profileName={profileName} onChoose={() => onChoose(feature)} onLater={() => void onLater(feature)} />
  );

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
  },
  errorTitle: {
    color: theme.colors.text,
    fontSize: theme.font.size.xl,
    fontWeight: "700",
  },
  errorText: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.md,
    textAlign: "center",
    lineHeight: 22,
  },
  retryButton: {
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.accent,
    borderRadius: 12,
  },
  retryButtonLabel: {
    color: theme.colors.bg,
    fontWeight: "700",
    fontSize: theme.font.size.md,
  },
});
