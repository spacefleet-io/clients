import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import {
  AudioLines,
  Bug,
  Captions,
  ChevronRight,
  Languages,
  Link,
  LogOut,
  Mail,
  MonitorSmartphone,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  SkipForward,
  Ticket,
  Tv,
  Type,
  UserCog,
  Users,
} from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MobileCreditsPanel, MobileOpenSourceNotice, useSkyScroll } from "@space/mobile-shell/components";
import { isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { MobileFlag } from "@space/mobile-shell/flag";
import { SelfUpdateSettings } from "@space/mobile-self-update";
import { founderBadgeText, useFounderStatus } from "@space/mobile-shell/founder";
import { founderCopy } from "@space/shared/founder";
import type { Session } from "@space/shared/api";
import { formatMediaLanguageOptionLabel } from "@space/shared/media-languages";
import { AUDIO_LANGUAGE_CHOICES } from "@space/shared/profileSettings";
import { TITLE_LANGUAGES } from "@space/shared/titleLanguage";
import { sessionDetail, sessionDisplayName, useAccountDevices } from "../../lib/accountDevices";
import { asksKeySavedBeforeSigningOut } from "../../lib/onboarding";
import {
  AUDIO_LANGUAGE_ORIGINAL,
  audioLanguageFromChoice,
  audioLanguageToChoice,
  useAppSettings,
  type DefaultQuality,
} from "../../lib/appSettings";
import { chooseUiLanguage } from "../../lib/uiLanguage";
import { useProfiles } from "../../lib/profiles/profileStore";
import { mobileCreditsSource } from "../../lib/metadata/runtime";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useAuth } from "../../store/auth";
import { TvListDialog, type TvListDialogItem } from "@space/mobile-shell/tv/TvListDialog";
import { TvSignOutKeyDialog } from "@space/mobile-shell/tv/TvSignOutKeyDialog";
import { TvNoticeHistoryDialog, TvNotificationsRow } from "@space/mobile-shell/tv/TvNoticeHistory";
import type { NoticeHistory } from "@space/notify-core/history";
import { DEVICES_TARGET } from "../../lib/pairing/newDevice";
import { rememberTvSettingsGroup, tvSettingsGroups, tvSettingsOpenGroup, type TvSettingsGroupId } from "../lib/tvSettingsGroups";
import { focusDestination, type TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { TvSegmented } from "@space/mobile-shell/tv/TvChip";
import { TvRow, TvRowList } from "@space/mobile-shell/tv/TvRow";
import { TvBody, TvEyebrow, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_RADII, TV_SPACE, TV_TYPE } from "../ui/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList>;

// UX-I18N-10: each language's flag and its own name.
const LANGUAGE_OPTIONS = MOBILE_UI_LANGUAGES.map((l) => ({ value: l.code as string, label: l.nativeName, lead: <MobileFlag code={l.code} /> }));
const AUDIO_LANGUAGE_OPTIONS = AUDIO_LANGUAGE_CHOICES.map((code) => ({ value: code as string, label: formatMediaLanguageOptionLabel(code) }));
const QUALITY_OPTIONS: readonly { value: DefaultQuality; label: string }[] = [
  { value: "2160p", label: "4K" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

/**
 * The dialog open over Settings, if any. Only one at a time: a sign-out confirmation replaces the devices list. The
 * key question (ACCT-DEV-03) remembers where it came from, so Cancel and Back return there.
 */
type SettingsDialog =
  | { kind: "quality" }
  | { kind: "audioLanguage" }
  | { kind: "subtitleLanguage" }
  | { kind: "titleLanguage" }
  | { kind: "devices" }
  | { kind: "notifications" }
  | { kind: "signOutDevice"; session: Session }
  | { kind: "signOutKey"; from: "settings" | "devices" }
  | null;

const log = (event: string, payload: Record<string, unknown>) => console.info(`tv.settings.${event}`, JSON.stringify(payload));

/**
 * TV Settings (UX-TV-42, UX-TV-43): the groups in a left column, the open group's rows at the right. Focusing a group
 * opens it; Right goes into its rows, Left from a row comes back to the open group. Every row is remote-focusable. Not on
 * the TV: downloads, the plan and payment screens, account deletion, the camera pairing and the server address field
 * (nothing to type with a remote). Long lists (the quality, the default audio and subtitle languages, the signed-in
 * devices) are one row each and open in a `TvListDialog` (UX-LIST-01).
 */
export const TvSettingsScreen = memo(({ history }: { history: NoticeHistory | null }) => {
  const { user, token } = useAuth();
  // Settings is only shown signed in; the guard keeps the devices hook from calling the API without a session.
  return token ? <TvSettingsContent token={token} email={user?.email ?? null} history={history} /> : null;
});
TvSettingsScreen.displayName = "TvSettingsScreen";

const TvSettingsContent = ({ token, email, history }: { token: string; email: string | null; history: NoticeHistory | null }) => {
  const { t, i18n } = useTranslation();
  const { logout } = useAuth();
  const navigation = useNavigation<Nav>();
  const [settings, update] = useAppSettings();
  const devices = useAccountDevices(token);
  const skyScroll = useSkyScroll();
  const styles = useTvStyles(baseStyles);
  const scale = useTvScale();
  const [dialog, setDialog] = useState<SettingsDialog>(null);
  // The row a closed dialog hands the focus back to.
  const [returnFocus, setReturnFocus] = useState<
    "quality" | "audioLanguage" | "subtitleLanguage" | "titleLanguage" | "devices" | "notifications" | "signOut" | null
  >(null);
  // UX-TV-42: the open group (the one last opened in this app session) and, until the remote moves, the focus on its
  // first row (the mockup's starting focus).
  const [group, setGroup] = useState<TvSettingsGroupId>(tvSettingsOpenGroup);
  const [focusFirstRow, setFocusFirstRow] = useState(true);
  const groupRefs = useRef(new Map<TvSettingsGroupId, TvViewInstance>());
  // The left column's focus guide sends the focus to the open group; its node exists only after the first commit.
  const [groupsMounted, setGroupsMounted] = useState(false);
  useEffect(() => setGroupsMounted(true), []);
  useEffect(() => {
    log("open", { group: tvSettingsOpenGroup() });
  }, []);
  const openGroup = useCallback((next: TvSettingsGroupId) => {
    setFocusFirstRow(false);
    setGroup((prev) => {
      if (prev !== next) log("group", { from: prev, to: next });
      return next;
    });
    rememberTvSettingsGroup(next);
  }, []);
  const language = i18n.language;
  const founder = useFounderStatus();

  const onLanguage = useCallback(
    // Picked while signed in: the account takes it too when it can hold it (UX-I18N-07; useAccountLanguageSync pushes).
    (code: string) => (isMobileUiLanguage(code) ? chooseUiLanguage(code, { pushToAccount: true }) : Promise.resolve()),
    [],
  );

  const openDialog = useCallback((next: Exclude<SettingsDialog, null>) => {
    log("dialog", { open: next.kind });
    setFocusFirstRow(false);
    setReturnFocus(null);
    setDialog(next);
  }, []);
  const closeDialog = useCallback(() => {
    log("dialog", { close: dialog?.kind ?? null });
    // A sign-out confirmation goes back to the devices list it came from.
    if (dialog?.kind === "signOutDevice" || (dialog?.kind === "signOutKey" && dialog.from === "devices")) {
      setDialog({ kind: "devices" });
      return;
    }
    setReturnFocus(
      dialog?.kind === "quality" ||
        dialog?.kind === "audioLanguage" ||
        dialog?.kind === "subtitleLanguage" ||
        dialog?.kind === "titleLanguage" ||
        dialog?.kind === "notifications"
        ? dialog.kind
        : dialog?.kind === "signOutKey"
          ? "signOut"
          : "devices",
    );
    setDialog(null);
  }, [dialog]);

  /**
   * ACCT-DEV-03: signing this TV out forgets the library key, so a TV that holds it first asks whether it was saved
   * (one question, also for this TV's own row in the devices list). Without a key, the Settings row signs out at once
   * and the devices list keeps its ordinary confirmation.
   */
  const signOutFromSettings = useCallback(async () => {
    const asks = await asksKeySavedBeforeSigningOut();
    log("signOut", { from: "settings", asks });
    if (asks) openDialog({ kind: "signOutKey", from: "settings" });
    else void logout("signOut");
  }, [logout, openDialog]);
  const signOutSelfFromDevices = useCallback(
    async (session: Session) => {
      const asks = await asksKeySavedBeforeSigningOut();
      log("signOut", { from: "devices", asks });
      openDialog(asks ? { kind: "signOutKey", from: "devices" } : { kind: "signOutDevice", session });
    },
    [openDialog],
  );

  const qualityItems = useMemo<TvListDialogItem[]>(
    () =>
      QUALITY_OPTIONS.map((option) => ({
        key: option.value,
        label: option.label,
        selected: option.value === settings.defaultQuality,
        testID: `tv-quality-${option.value}`,
        onPress: () => {
          log("quality", { quality: option.value });
          update({ defaultQuality: option.value });
          setDialog(null);
          setReturnFocus("quality");
        },
      })),
    [settings.defaultQuality, update],
  );
  const qualityLabel = QUALITY_OPTIONS.find((option) => option.value === settings.defaultQuality)?.label ?? settings.defaultQuality;

  const audioOptions = useMemo(
    () => [{ value: AUDIO_LANGUAGE_ORIGINAL, label: t("settings.playback.audioLanguage.original") }, ...AUDIO_LANGUAGE_OPTIONS],
    [t],
  );
  const audioChoice = audioLanguageToChoice(settings.defaultAudioLanguage);

  const audioItems = useMemo<TvListDialogItem[]>(
    () =>
      audioOptions.map((option) => ({
        key: option.value || "original",
        label: option.label,
        selected: option.value === audioChoice,
        testID: `tv-audio-language-${option.value || "original"}`,
        onPress: () => {
          log("audioLanguage", { choice: option.value || "original" });
          update({ defaultAudioLanguage: audioLanguageFromChoice(option.value) });
          setDialog(null);
          setReturnFocus("audioLanguage");
        },
      })),
    [audioChoice, audioOptions, update],
  );

  // ACCT-SQUAD-03: the same languages as the audio list, "No preference" first (the file's own default subtitles).
  const subtitleOptions = useMemo(
    () => [{ value: AUDIO_LANGUAGE_ORIGINAL, label: t("subtitleLanguage.none") }, ...AUDIO_LANGUAGE_OPTIONS],
    [t],
  );
  const subtitleChoice = audioLanguageToChoice(settings.defaultSubtitleLanguage);
  const subtitleItems = useMemo<TvListDialogItem[]>(
    () =>
      subtitleOptions.map((option) => ({
        key: option.value || "none",
        label: option.label,
        selected: option.value === subtitleChoice,
        testID: `tv-subtitle-language-${option.value || "none"}`,
        onPress: () => {
          log("subtitleLanguage", { choice: option.value || "none" });
          update({ defaultSubtitleLanguage: audioLanguageFromChoice(option.value) });
          setDialog(null);
          setReturnFocus("subtitleLanguage");
        },
      })),
    [subtitleChoice, subtitleOptions, update],
  );

  // ACCT-PROF-03: how this profile sees titles, posters and backdrops (the setup asked it of new profiles).
  const titleLanguageItems = useMemo<TvListDialogItem[]>(
    () =>
      TITLE_LANGUAGES.map((value) => ({
        key: value,
        label: t(`titleLanguage.${value}.label`),
        detail: t(`titleLanguage.${value}.description`),
        selected: value === settings.titleLanguage,
        testID: `tv-title-language-${value}`,
        onPress: () => {
          log("titleLanguage", { choice: value });
          update({ titleLanguage: value });
          setDialog(null);
          setReturnFocus("titleLanguage");
        },
      })),
    [settings.titleLanguage, t, update],
  );

  const { sessions, load: reloadDevices, signOut: signOutDevice } = devices;
  const deviceItems = useMemo<TvListDialogItem[]>(() => {
    let other = 0;
    const rows = sessions.map((session) => ({
      key: session.id,
      label: session.current ? t("tvShell.devices.thisDevice", { name: sessionDisplayName(session) }) : sessionDisplayName(session),
      detail: sessionDetail(session),
      testID: session.current ? "tv-device-current" : `tv-device-other-${other++}`,
      onPress: () => (session.current ? void signOutSelfFromDevices(session) : openDialog({ kind: "signOutDevice", session })),
    }));
    return [
      ...rows,
      { key: "refresh", label: t("account.devices.refresh"), testID: "tv-devices-refresh", onPress: () => void reloadDevices() },
    ];
  }, [openDialog, reloadDevices, sessions, signOutSelfFromDevices, t]);

  const confirmItems = useMemo<TvListDialogItem[]>(() => {
    if (dialog?.kind !== "signOutDevice") return [];
    const { session } = dialog;
    return [
      { key: "cancel", label: t("account.devices.cancel"), testID: "tv-device-signout-cancel", onPress: closeDialog },
      {
        key: "confirm",
        label: t("account.devices.revoke"),
        danger: true,
        testID: "tv-device-signout-confirm",
        onPress: () => {
          if (session.current) {
            // Signing this TV out is the ordinary sign-out: the session ends here and the app goes back to sign-in.
            log("devices.signOutSelf", { sessionId: session.id });
            setDialog(null);
            void logout("signOut");
            return;
          }
          void signOutDevice(session).then((ok) => {
            log("devices.signedOut", { sessionId: session.id, ok });
            setDialog({ kind: "devices" });
          });
        },
      },
    ];
  }, [closeDialog, dialog, logout, signOutDevice, t]);

  const keyText = useMemo(
    () => ({
      title: t("account.signOutKey.title"),
      body: t("account.signOutKey.body"),
      cancel: t("account.signOutKey.cancel"),
      confirm: t("account.signOutKey.confirm"),
    }),
    [t],
  );
  const confirmSignOutKey = useCallback(() => {
    log("signOutKey.confirmed", { from: dialog?.kind === "signOutKey" ? dialog.from : null });
    setDialog(null);
    void logout("signOut");
  }, [dialog, logout]);

  const devicesSummary =
    devices.sessions.length === 0
      ? devices.loading
        ? t("account.devices.loading")
        : devices.error
          ? t(`account.devices.errors.${devices.error}`)
          : t("account.devices.empty")
      : t("account.devices.summary", { count: devices.sessions.length });
  const profiles = useProfiles();
  const activeProfile = profiles.profiles.find((profile) => profile.id === profiles.activeId) ?? null;
  const first = focusFirstRow;
  const audioLabel = audioOptions.find((option) => option.value === audioChoice)?.label ?? audioChoice;
  const subtitleLabel = subtitleOptions.find((option) => option.value === subtitleChoice)?.label ?? subtitleChoice;

  const renderGroup = (): React.ReactNode => {
    switch (group) {
      case "profiles":
        // UX-PROF-01: switching profile takes one step and never asks to sign in again.
        return (
          <TvRowList>
            {profiles.profiles.length > 1 ? (
              <TvRow
                testID="settings-switch-profile"
                icon={Users}
                title={t("profiles.switch")}
                description={activeProfile ? t("profiles.watchingAs", { name: activeProfile.name }) : undefined}
                hasTVPreferredFocus={first}
                onPress={() => navigation.navigate("SwitchProfile", { mode: "pick" })}
              />
            ) : null}
            <TvRow
              testID="settings-manage-profiles"
              icon={UserCog}
              title={t("profiles.manage")}
              description={t("profiles.manageHint")}
              hasTVPreferredFocus={first && profiles.profiles.length <= 1}
              onPress={() => navigation.navigate("SwitchProfile", { mode: "manage" })}
            />
          </TvRowList>
        );
      case "account":
        return (
          <TvRowList>
            {/* Read-only: the remote skips it. */}
            <TvRow
              testID="tv-settings-email"
              icon={Mail}
              title={email ?? t("settings.account.unknown")}
              description={t("settings.account.signedInAs")}
              end={{ kind: "none" }}
              focusable={false}
              accessibilityRole="text"
            />
            {/* WAIT-FOUND-04: "Founder 🎫 · since the waitlist, {date}" and the discount; read-only like the email. The TV
                has no plan screen and shows no price (ACCT-PAY-02), so the founder price line lives here. */}
            {founder?.founder ? (
              <TvRow
                testID="tv-settings-founder"
                icon={Ticket}
                title={founderBadgeText(language, founder.since)}
                description={founderCopy(language).priceLabel}
                end={{ kind: "none" }}
                focusable={false}
                accessibilityRole="text"
              />
            ) : null}
            <TvRow
              testID="tv-settings-devices"
              icon={MonitorSmartphone}
              title={t("account.devices.title")}
              description={devicesSummary}
              hasTVPreferredFocus={first || returnFocus === "devices"}
              onPress={() => openDialog({ kind: "devices" })}
            />
            {/* UX-NOTICE-04 / UX-NOTICE-12: the TV's notice history, with the unread count at the row's end. */}
            <TvNotificationsRow
              history={history}
              hasTVPreferredFocus={returnFocus === "notifications"}
              onPress={() => openDialog({ kind: "notifications" })}
            />
            <TvRow
              testID="tv-settings-pair"
              icon={Link}
              title={t("tvPairing.approve.settingsRow")}
              description={t("tvPairing.approve.settingsHint")}
              onPress={() => navigation.navigate("PairDevice", {})}
            />
            <TvRow
              testID="tv-settings-sign-out"
              icon={LogOut}
              title={t("settings.account.signOut")}
              danger
              end={{ kind: "none" }}
              hasTVPreferredFocus={returnFocus === "signOut"}
              onPress={() => void signOutFromSettings()}
            />
          </TvRowList>
        );
      case "playback":
        return (
          <>
            <TvRowList>
              <TvRow
                testID="tv-settings-autoplay"
                icon={Play}
                title={t("settings.playback.autoplay.title")}
                description={t("settings.playback.autoplay.description")}
                end={{ kind: "toggle", value: settings.autoplayNextEpisode }}
                hasTVPreferredFocus={first}
                onPress={() => update({ autoplayNextEpisode: !settings.autoplayNextEpisode })}
              />
              <TvRow
                testID="tv-settings-skip-intro"
                icon={RotateCcw}
                title={t("settings.playback.intro.title")}
                description={t("settings.playback.intro.description")}
                end={{ kind: "toggle", value: settings.autoSkipIntro }}
                onPress={() => update({ autoSkipIntro: !settings.autoSkipIntro })}
              />
              <TvRow
                testID="tv-settings-skip-credits"
                icon={SkipForward}
                title={t("settings.playback.credits.title")}
                description={t("settings.playback.credits.description")}
                end={{ kind: "toggle", value: settings.autoSkipCredits }}
                onPress={() => update({ autoSkipCredits: !settings.autoSkipCredits })}
              />
            </TvRowList>
            <TvEyebrow tone="muted" style={styles.heading} accessibilityRole="header">
              {t("tvShell.settings.qualityAndLanguages")}
            </TvEyebrow>
            <TvRowList>
              {/* UX-TV-43: one row with the current value; the four qualities open in a window like the languages. */}
              <TvRow
                testID="tv-settings-quality"
                icon={Tv}
                title={t("settings.playback.quality.title")}
                end={{ kind: "value", value: settings.forceQuality ? qualityLabel : t("tvShell.settings.qualityValueAuto", { quality: qualityLabel }) }}
                hasTVPreferredFocus={returnFocus === "quality"}
                onPress={() => openDialog({ kind: "quality" })}
              />
              <TvRow
                testID="tv-settings-force-quality"
                icon={SettingsIcon}
                title={t("settings.playback.force.title")}
                description={t("tvShell.settings.forceDescription")}
                end={{ kind: "toggle", value: settings.forceQuality }}
                onPress={() => update({ forceQuality: !settings.forceQuality })}
              />
              {/* UX-LIST-01: every language is too many for the row; they open in a window. */}
              <TvRow
                testID="tv-settings-audio-language"
                icon={AudioLines}
                title={t("settings.playback.audioLanguage.title")}
                end={{ kind: "value", value: audioLabel }}
                hasTVPreferredFocus={returnFocus === "audioLanguage"}
                onPress={() => openDialog({ kind: "audioLanguage" })}
              />
              {/* ACCT-SQUAD-03: the subtitle language belongs to the profile in use. */}
              <TvRow
                testID="tv-settings-subtitle-language"
                icon={Captions}
                title={t("subtitleLanguage.title")}
                description={t("tvShell.settings.subtitleForProfile")}
                end={{ kind: "value", value: subtitleLabel }}
                hasTVPreferredFocus={returnFocus === "subtitleLanguage"}
                onPress={() => openDialog({ kind: "subtitleLanguage" })}
              />
            </TvRowList>
          </>
        );
      case "privacy":
        // REL-LOG-06: the same stored answer as the setup step and the phone; the reporter follows it at once.
        return (
          <TvRowList>
            <TvRow
              testID="tv-settings-error-reports"
              icon={Bug}
              title={t("settings.privacy.errorReports.title")}
              description={t("settings.privacy.errorReports.description")}
              end={{ kind: "toggle", value: settings.errorReports }}
              hasTVPreferredFocus={first}
              onPress={() => {
                const errorReports = !settings.errorReports;
                log("errorReports", { errorReports });
                update({ errorReports });
              }}
            />
          </TvRowList>
        );
      case "language":
        return (
          <>
            {/* UX-I18N-10: the languages side by side, each with its flag and its own name; Left/Right, OK picks. */}
            <View style={styles.languageBlock} testID="tv-settings-app-language-row">
              <View style={styles.languageHead}>
                <View style={styles.languageIcon}>
                  <Languages size={13 * scale} color={TV_COLOR.text} />
                </View>
                <View style={styles.languageText}>
                  <TvBody>{t("settings.language.appLanguage")}</TvBody>
                  <TvBody size="small" muted>
                    {t("settings.language.accountWide")}
                  </TvBody>
                </View>
              </View>
              <TvSegmented
                testID="tv-settings-app-language"
                options={LANGUAGE_OPTIONS}
                value={language}
                preferredValue={first ? language : undefined}
                onChange={(code) => void onLanguage(code)}
              />
            </View>
            <TvRowList>
              <TvRow
                testID="tv-settings-title-language"
                icon={Type}
                title={t("titleLanguage.settingTitle")}
                description={t("titleLanguage.settingDescription")}
                end={{ kind: "value", value: t(`titleLanguage.${settings.titleLanguage}.label`) }}
                hasTVPreferredFocus={returnFocus === "titleLanguage"}
                onPress={() => openDialog({ kind: "titleLanguage" })}
              />
            </TvRowList>
          </>
        );
      case "about":
        // UX-SET-03 then UX-SET-02: the GPL-3.0 line with the source code's address and QR code (no browser on a TV),
        // then the outside data sources, credited here out of the everyday screens under the panel's own header row
        // (closed by default, opened with the remote's select). REL-UPD-06: on a hand-installed APK, the version and its
        // updates first.
        return (
          <View style={styles.about}>
            <SelfUpdateSettings language={language} scale={scale} />
            <MobileOpenSourceNotice language={language} product="badger" openLinks={false} scale={scale} />
            <MobileCreditsPanel language={language} product="badger" source={mobileCreditsSource} openLinks={false} scale={scale} />
          </View>
        );
    }
  };

  const groups = tvSettingsGroups();
  const openLabel = t(groups.find((item) => item.id === group)?.labelKey ?? "");
  const openGroupNode = groupsMounted ? (groupRefs.current.get(group) ?? null) : null;

  return (
    <View style={styles.root}>
      <View
        style={styles.columns}
        // While a dialog is open, the page behind it is out of the screen reader's reach.
        importantForAccessibility={dialog ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={dialog !== null}
      >
        {/* UX-TV-42: a move into the left column (Left from a row, Down from the top bar) lands on the open group. */}
        <TVFocusGuideView
          style={styles.groups}
          destinations={focusDestination(openGroupNode)}
          accessibilityRole="tablist"
          accessibilityLabel={t("tvShell.settings.groupsLabel")}
          testID="tv-settings-groups"
        >
          {groups.map(({ id, labelKey, icon: Icon }) => {
            const selected = id === group;
            return (
              <TvFocusable
                key={id}
                ref={(node: TvViewInstance | null) => {
                  if (node) groupRefs.current.set(id, node);
                  else groupRefs.current.delete(id);
                }}
                testID={`tv-settings-group-${id}`}
                style={[styles.group, selected && styles.groupSelected]}
                ring="inside"
                scale={1}
                onFocus={() => openGroup(id)}
                onPress={() => openGroup(id)}
                accessibilityRole="tab"
                accessibilityLabel={t(labelKey)}
                accessibilityState={{ selected }}
              >
                <Icon size={15 * scale} color={selected ? TV_COLOR.amber : TV_COLOR.muted} />
                <Text style={[styles.groupLabel, selected && styles.groupLabelSelected]} numberOfLines={1}>
                  {t(labelKey)}
                </Text>
                <ChevronRight size={12 * scale} color={TV_COLOR.muted} />
              </TvFocusable>
            );
          })}
        </TVFocusGuideView>

        {/* A move into the right column lands on the row last focused there, else the open group's first row. */}
        <TVFocusGuideView autoFocus style={styles.pane} testID={`tv-settings-pane-${group}`}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} {...skyScroll}>
            <TvTitle size="page">{openLabel}</TvTitle>
            {renderGroup()}
          </ScrollView>
        </TVFocusGuideView>
      </View>

      {dialog?.kind === "quality" ? (
        <TvListDialog
          testID="tv-quality-dialog"
          title={t("settings.playback.quality.title")}
          message={t(settings.forceQuality ? "tvShell.settings.qualityForced" : "tvShell.settings.qualityAuto", { quality: qualityLabel })}
          items={qualityItems}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "audioLanguage" ? (
        <TvListDialog
          testID="tv-audio-language-dialog"
          title={t("settings.playback.audioLanguage.title")}
          message={t("settings.playback.audioLanguage.description")}
          items={audioItems}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "subtitleLanguage" ? (
        <TvListDialog
          testID="tv-subtitle-language-dialog"
          title={t("subtitleLanguage.title")}
          message={t("subtitleLanguage.description")}
          items={subtitleItems}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "titleLanguage" ? (
        <TvListDialog
          testID="tv-title-language-dialog"
          title={t("titleLanguage.question")}
          message={t("titleLanguage.intro")}
          items={titleLanguageItems}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "devices" ? (
        <TvListDialog
          testID="tv-devices-dialog"
          title={t("account.devices.title")}
          message={t("account.devices.footnote")}
          error={devices.error ? t(`account.devices.errors.${devices.error}`) : null}
          items={deviceItems}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "notifications" ? (
        <TvNoticeHistoryDialog
          history={history}
          onClose={closeDialog}
          onOpenTarget={(target) => (target === DEVICES_TARGET ? openDialog({ kind: "devices" }) : closeDialog())}
        />
      ) : null}
      {dialog?.kind === "signOutDevice" ? (
        <TvListDialog
          testID="tv-device-signout-dialog"
          title={
            dialog.session.current
              ? t("tvShell.devices.confirmSelfTitle")
              : t("account.devices.confirmTitle", { name: sessionDisplayName(dialog.session) })
          }
          message={dialog.session.current ? t("tvShell.devices.confirmSelfBody") : t("account.devices.confirmExplanation")}
          items={confirmItems}
          initialFocusKey="cancel"
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "signOutKey" ? <TvSignOutKeyDialog text={keyText} onCancel={closeDialog} onConfirm={confirmSignOutKey} /> : null}
    </View>
  );
};

/** Sizes in design dp: the mockup's px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  root: { flex: 1 },
  // Mockup `.cols`: groups 520 px wide, a 48 px gap, padding 44 px 72 px 0.
  columns: { flex: 1, flexDirection: "row", gap: 24, paddingTop: 22, paddingHorizontal: TV_SPACE.screenX },
  groups: { width: 260, gap: 4 },
  // Mockup `.grp`: 84 px high, radius 16, 27 px semibold, the open one on the card colour with a thin border.
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 42,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 0.75,
    borderColor: "transparent",
  },
  groupSelected: { backgroundColor: TV_COLOR.cardOnSky, borderColor: TV_COLOR.borderSoft },
  groupLabel: { flex: 1, fontFamily: TV_TYPE.body.fontFamily, fontSize: 13.5, fontWeight: "600", color: TV_COLOR.muted },
  groupLabelSelected: { color: TV_COLOR.text },
  pane: { flex: 1 },
  scroll: { flex: 1 },
  content: { gap: 11, paddingBottom: 44 },
  heading: { marginTop: 9 },
  languageBlock: { gap: 11, padding: 14, borderRadius: TV_RADII.card, backgroundColor: TV_COLOR.listOnSky, borderWidth: 0.75, borderColor: "rgba(68, 71, 90, 0.55)" },
  languageHead: { flexDirection: "row", alignItems: "center", gap: 11 },
  languageIcon: { width: 26, height: 26, borderRadius: TV_RADII.control, alignItems: "center", justifyContent: "center", backgroundColor: TV_COLOR.secondary },
  languageText: { flex: 1, gap: 2 },
  about: { gap: 14 },
});
