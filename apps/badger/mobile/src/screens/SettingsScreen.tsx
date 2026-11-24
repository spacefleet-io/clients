import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import {
  MobileCreditsPanel,
  MobileErrorReportsLink,
  MobileFounderBadge,
  MobileOpenSourceNotice,
  useSkyScroll,
} from "@space/mobile-shell/components";
import { isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { MobileFlag } from "@space/mobile-shell/flag";
import { formatMediaLanguageOptionLabel } from "@space/shared/media-languages";
import { AUDIO_LANGUAGE_CHOICES } from "@space/shared/profileSettings";
import { useAuth } from "../store/auth";
import { getStoredApiHost, serverPickerAllowed, setStoredApiHost } from "../lib/apiConfig";
import {
  ANIMATED_BACKGROUND_CHOICES,
  AUDIO_LANGUAGE_ORIGINAL,
  audioLanguageFromChoice,
  audioLanguageToChoice,
  useAppSettings,
  type DefaultQuality,
} from "../lib/appSettings";
import { automaticSkyMode } from "../lib/skyMode";
import { chooseUiLanguage } from "../lib/uiLanguage";
import { useProfiles } from "../lib/profiles/profileStore";
import { mobileCreditsSource } from "../lib/metadata/runtime";
import { RootStackParamList } from "../navigation/AppNavigator";
import { ChoiceRow, Divider, LinkRow, SettingsGroup, SwitchRow } from "../components/SettingsRows";
import { keyChangeOffered } from "@space/shared/keyChange";
import { useKeyRotationReadiness } from "@space/shared/useKeyRotationReadiness";
import { TITLE_LANGUAGES } from "@space/shared/titleLanguage";
import { useSignOut } from "../lib/useSignOut";
import { PasswordChangeSection } from "../components/AccountSecurity";
import { DevicesSection } from "../components/DevicesSection";
import { NewsOptInRow } from "../components/NewsOptInRow";
import { RIPPLE } from "../components/PosterCard";
import { theme } from "../theme/theme";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";
import { SelfUpdateSettings } from "@space/mobile-self-update";

type Nav = NativeStackNavigationProp<RootStackParamList>;

// UX-I18N-10: each language's flag and its own name.
const LANGUAGE_OPTIONS = MOBILE_UI_LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName, lead: <MobileFlag code={l.code} width={21} /> }));
const AUDIO_LANGUAGE_OPTIONS = AUDIO_LANGUAGE_CHOICES.map((code) => ({ value: code as string, label: formatMediaLanguageOptionLabel(code) }));

const QUALITY_OPTIONS: readonly { value: DefaultQuality; label: string }[] = [
  { value: "2160p", label: "4K" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

/**
 * Settings tab content (rendered inside the shell frame, so no screen wrapper).
 *
 * @param devicesRequest bumped when "Your devices" must show (the new-device banner or notification, ACCT-PAIR-03): the
 *   page scrolls to the devices card and opens the device list.
 */
export const SettingsScreen = memo(({ devicesRequest = 0 }: { devicesRequest?: number }) => {
  const { t, i18n } = useTranslation();
  const { user, token, setUser } = useAuth();
  // ACCT-KEYCHG-04: the key-change row shows exactly when the server would accept the change.
  const keyChange = keyChangeOffered(useKeyRotationReadiness(token));
  const signOut = useSignOut();
  const navigation = useNavigation<Nav>();
  const [settings, update] = useAppSettings();
  const skyScroll = useSkyScroll();
  const language = i18n.language;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The server address field is the server picker: development builds only (ACCT-AUTH-09).
  const serverPicker = serverPickerAllowed();
  const [host, setHost] = useState("");
  const [hostSaved, setHostSaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  // Where the devices card sits in the page, once laid out; a request made before that scrolls on layout.
  const devicesY = useRef<number | null>(null);
  const devicesScrollPending = useRef(false);
  const scrollToDevices = useCallback(() => {
    if (devicesY.current === null) {
      devicesScrollPending.current = true;
      return;
    }
    devicesScrollPending.current = false;
    scrollRef.current?.scrollTo({ y: devicesY.current, animated: false });
  }, []);
  useEffect(() => {
    if (devicesRequest > 0) scrollToDevices();
  }, [devicesRequest, scrollToDevices]);

  useEffect(() => {
    let cancelled = false;
    if (serverPicker) {
      void getStoredApiHost().then((value) => {
        if (!cancelled && value) setHost(value);
      });
    }
    return () => {
      cancelled = true;
      clearTimeout(saveTimerRef.current);
    };
  }, [serverPicker]);

  const onLanguage = useCallback(
    // Picked while signed in: the account takes it too when it can hold it (UX-I18N-07; useAccountLanguageSync pushes).
    (code: string) => (isMobileUiLanguage(code) ? chooseUiLanguage(code, { pushToAccount: Boolean(token) }) : Promise.resolve()),
    [token]
  );

  const onSaveHost = useCallback(async () => {
    await setStoredApiHost(host.trim());
    setHostSaved(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => setHostSaved(false), 1500);
  }, [host]);

  const email = user?.email ?? t("settings.account.unknown");
  const profiles = useProfiles();
  const activeProfile = profiles.profiles.find((profile) => profile.id === profiles.activeId) ?? null;

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-screen"
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      {...skyScroll}
    >
      <Text style={styles.title} accessibilityRole="header">
        {t("settings.title")}
      </Text>

      {/* UX-PROF-01: switching profile takes one step and never asks to sign in again. */}
      <SettingsGroup title={t("profiles.settingsGroup")}>
        {profiles.profiles.length > 1 ? (
          <>
            <LinkRow
              title={t("profiles.switch")}
              description={activeProfile ? t("profiles.watchingAs", { name: activeProfile.name }) : undefined}
              onPress={() => navigation.navigate("SwitchProfile", { mode: "pick" })}
            />
            <Divider />
          </>
        ) : null}
        <LinkRow
          title={t("profiles.manage")}
          description={t("profiles.manageHint")}
          onPress={() => navigation.navigate("SwitchProfile", { mode: "manage" })}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.account.title")}>
        <View style={styles.accountRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{email.slice(0, 2).toUpperCase()}</Text>
          </View>
          <View style={styles.accountText}>
            <Text style={styles.accountLabel}>{t("settings.account.signedInAs")}</Text>
            <Text style={styles.accountEmail} numberOfLines={1}>
              {email}
            </Text>
            {/* WAIT-FOUND-04: a founder sees it on the account, every time Settings opens. */}
            <MobileFounderBadge />
          </View>
        </View>
        <Divider />
        <LinkRow
          title={t("settings.account.plan")}
          testID="settings-plan"
          description={t("settings.account.planDescription")}
          onPress={() => navigation.navigate("Subscription")}
        />
        <Divider />
        <LinkRow
          title={t("settings.account.pairDevice.title")}
          description={t("settings.account.pairDevice.description")}
          onPress={() => navigation.navigate("PairDevice", {})}
        />
        <Divider />
        {token ? (
          <>
            {/* ACCT-NEWS-01: News emails on or off, stored on the account. */}
            <NewsOptInRow token={token} user={user} onUser={setUser} language={language} />
            <Divider />
          </>
        ) : null}
        <LinkRow
          title={t("settings.account.signOut")}
          danger
          chevron={false}
          testID="settings-sign-out"
          onPress={() => void signOut()}
        />
        <Divider />
        <LinkRow
          title={t("settings.account.deleteAccount")}
          description={
            user?.deletionScheduledFor
              ? t("settings.account.deletionScheduled", {
                  date: new Date(user.deletionScheduledFor).toLocaleDateString(language),
                })
              : undefined
          }
          danger
          onPress={() => navigation.navigate("DeleteAccount")}
        />
      </SettingsGroup>

      {token ? (
        <View
          testID="settings-devices"
          onLayout={(event) => {
            devicesY.current = event.nativeEvent.layout.y;
            if (devicesScrollPending.current) scrollToDevices();
          }}
        >
          <DevicesSection token={token} openRequest={devicesRequest} />
        </View>
      ) : null}

      <SettingsGroup title={t("settings.playback.title")}>
        <SwitchRow
          title={t("settings.playback.autoplay.title")}
          description={t("settings.playback.autoplay.description")}
          value={settings.autoplayNextEpisode}
          onValueChange={(autoplayNextEpisode) => update({ autoplayNextEpisode })}
        />
        <Divider />
        <SwitchRow
          title={t("settings.playback.intro.title")}
          description={t("settings.playback.intro.description")}
          value={settings.autoSkipIntro}
          onValueChange={(autoSkipIntro) => update({ autoSkipIntro })}
        />
        <Divider />
        <SwitchRow
          title={t("settings.playback.credits.title")}
          description={t("settings.playback.credits.description")}
          value={settings.autoSkipCredits}
          onValueChange={(autoSkipCredits) => update({ autoSkipCredits })}
        />
        <Divider />
        <ChoiceRow
          title={t("settings.playback.quality.title")}
          testID="settings-default-quality"
          description={
            settings.forceQuality
              ? t("settings.playback.quality.descriptionForced", { quality: settings.defaultQuality })
              : t("settings.playback.quality.descriptionAuto", { quality: settings.defaultQuality })
          }
          options={QUALITY_OPTIONS}
          value={settings.defaultQuality}
          onChange={(defaultQuality) => update({ defaultQuality })}
        />
        <Divider />
        <SwitchRow
          title={t("settings.playback.force.title")}
          testID="settings-force-quality"
          description={t("settings.playback.force.description")}
          value={settings.forceQuality}
          onValueChange={(forceQuality) => update({ forceQuality })}
        />
        <Divider />
        <ChoiceRow
          title={t("settings.playback.audioLanguage.title")}
          description={t("settings.playback.audioLanguage.description")}
          options={[{ value: AUDIO_LANGUAGE_ORIGINAL, label: t("settings.playback.audioLanguage.original") }, ...AUDIO_LANGUAGE_OPTIONS]}
          value={audioLanguageToChoice(settings.defaultAudioLanguage)}
          onChange={(choice) => update({ defaultAudioLanguage: audioLanguageFromChoice(choice) })}
        />
        <Divider />
        {/* ACCT-SQUAD-03: subtitles start in this language when the title has no remembered choice and the file has it. */}
        <ChoiceRow
          title={t("subtitleLanguage.title")}
          description={t("subtitleLanguage.description")}
          options={[{ value: AUDIO_LANGUAGE_ORIGINAL, label: t("subtitleLanguage.none") }, ...AUDIO_LANGUAGE_OPTIONS]}
          value={audioLanguageToChoice(settings.defaultSubtitleLanguage)}
          onChange={(choice) => update({ defaultSubtitleLanguage: audioLanguageFromChoice(choice) })}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.downloads.title")}>
        <SwitchRow
          title={t("settings.downloads.wifiOnly.title")}
          description={t("settings.downloads.wifiOnly.description")}
          value={settings.downloadsWifiOnly}
          onValueChange={(downloadsWifiOnly) => update({ downloadsWifiOnly })}
        />
        <Divider />
        <LinkRow
          title={t("settings.downloads.manage.title")}
          description={t("settings.downloads.manage.description")}
          onPress={() => navigation.navigate("Downloads")}
        />
        <Divider />
        {/* OFFL-MANAGE-01: what is kept on this phone, its size, remove one or all. */}
        <LinkRow
          testID="settings-offline-content"
          title={t("offlineContent.entry")}
          description={t("offlineContent.badger.entryDescription")}
          onPress={() => navigation.navigate("OfflineContent")}
        />
      </SettingsGroup>

      {/* REL-LOG-06: only in a build that can send reports; a build with no reporting address has no Privacy group (#2570). */}
      {errorReportsOffered() ? (
        <SettingsGroup title={t("settings.privacy.title")}>
          <SwitchRow
            title={t("settings.privacy.errorReports.title")}
            description={t("settings.privacy.errorReports.description")}
            extra={<MobileErrorReportsLink testID="settings-error-reports-link" />}
            value={settings.errorReports}
            onValueChange={(errorReports) => update({ errorReports })}
          />
        </SettingsGroup>
      ) : null}

      {/* UX-SUP-05: the closed test's feedback channel, landing in the admin dashboard's Feedback inbox. */}
      <SettingsGroup title={t("feedback.settingsGroup")}>
        <LinkRow
          title={t("feedback.entry")}
          description={t("feedback.entryDescription")}
          onPress={() => navigation.navigate("Feedback")}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.language.title")}>
        <ChoiceRow
          title={t("settings.language.appLanguage")}
          description={t("settings.language.accountWide")}
          options={LANGUAGE_OPTIONS}
          value={language}
          onChange={(code) => void onLanguage(code)}
        />
        <Divider />
        {/* ACCT-PROF-03: how this profile sees titles, posters and backdrops; the setup asked it of new profiles. */}
        <ChoiceRow
          title={t("titleLanguage.settingTitle")}
          description={t("titleLanguage.settingDescription")}
          testID="settings-title-language"
          options={TITLE_LANGUAGES.map((value) => ({ value, label: t(`titleLanguage.${value}.label`) }))}
          value={settings.titleLanguage}
          onChange={(titleLanguage) => update({ titleLanguage })}
        />
      </SettingsGroup>

      <View style={styles.advanced}>
        <Pressable
          style={styles.advancedHeader}
          onPress={() => setAdvancedOpen((open) => !open)}
          android_ripple={RIPPLE}
          accessibilityRole="button"
          accessibilityLabel={t("settings.advanced.title")}
          accessibilityState={{ expanded: advancedOpen }}
        >
          <Text style={styles.advancedTitle}>{t("settings.advanced.title")}</Text>
          {advancedOpen ? (
            <ChevronUp size={18} color={theme.colors.textMuted} />
          ) : (
            <ChevronDown size={18} color={theme.colors.textMuted} />
          )}
        </Pressable>

        {advancedOpen ? (
          <View style={styles.advancedBody}>
            {serverPicker ? (
              <SettingsGroup title={t("settings.advanced.server")}>
                <View style={styles.hostBox}>
                  <Text style={styles.hostLabel}>{t("settings.advanced.apiHost")}</Text>
                  <TextInput
                    value={host}
                    onChangeText={setHost}
                    placeholder={t("settings.advanced.apiHostPlaceholder")}
                    placeholderTextColor={theme.colors.textDim}
                    style={styles.hostInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={t("settings.advanced.apiHost")}
                  />
                  <Pressable
                    style={styles.hostSave}
                    onPress={() => void onSaveHost()}
                    android_ripple={{ color: "rgba(18,20,33,0.25)" }}
                    accessibilityRole="button"
                    accessibilityLabel={t("settings.advanced.saveHostLabel")}
                  >
                    <Text style={styles.hostSaveText}>
                      {hostSaved ? t("settings.advanced.hostSaved") : t("settings.advanced.saveHost")}
                    </Text>
                  </Pressable>
                </View>
              </SettingsGroup>
            ) : null}
            <SettingsGroup>
              <ChoiceRow
                title={t("settings.advanced.animatedBackground.title")}
                description={`${t("settings.advanced.animatedBackground.description")} ${t(`settings.advanced.animatedBackground.automatic.${automaticSkyMode()}`)}`}
                options={ANIMATED_BACKGROUND_CHOICES.map((value) => ({
                  value,
                  label: t(`settings.advanced.animatedBackground.${value}`),
                }))}
                value={settings.animatedBackground}
                onChange={(animatedBackground) => update({ animatedBackground })}
              />
            </SettingsGroup>
            {/* ACCT-KEYCHG-04: no key-change entry while the account's media could not be re-sealed. */}
            {keyChange ? (
              <SettingsGroup title={t("settings.advanced.libraryKey")}>
                <LinkRow
                  title={t("settings.advanced.resetKey.title")}
                  description={t("settings.advanced.resetKey.description")}
                  onPress={() => navigation.navigate("ResetKey")}
                />
              </SettingsGroup>
            ) : null}
            {token ? <PasswordChangeSection token={token} hasPassword={user?.hasPassword !== false} /> : null}
          </View>
        ) : null}
      </View>

      {/* UX-SET-03 then UX-SET-02: the GPL-3.0 line and the link to the source code, then the outside data sources,
          credited here out of the everyday screens under the panel's own About header row (closed by default), so the
          group carries no second "About" title. REL-UPD-06: on a hand-installed APK, the version and its updates first. */}
      <SettingsGroup>
        <SelfUpdateSettings language={language} />
        <MobileOpenSourceNotice language={language} product="badger" openLinks />
        <MobileCreditsPanel language={language} product="badger" source={mobileCreditsSource} openLinks />
      </SettingsGroup>
    </ScrollView>
  );
});
SettingsScreen.displayName = "SettingsScreen";

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingTop: 8, paddingBottom: 24, gap: 20 },
  title: { fontSize: 28, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  avatarText: { fontSize: 16, fontWeight: "900", color: theme.colors.bg },
  accountText: { flex: 1, gap: 2 },
  accountLabel: { fontSize: 11, letterSpacing: 1.2, color: theme.colors.textDim, textTransform: "uppercase" },
  accountEmail: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  advanced: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  advancedHeader: {
    minHeight: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  advancedTitle: { fontSize: 15, fontWeight: "700", color: theme.colors.textMuted },
  advancedBody: { gap: 20, paddingHorizontal: 12, paddingBottom: 16 },
  hostBox: { padding: 16, gap: 10 },
  hostLabel: { fontSize: 12, color: theme.colors.textMuted },
  hostInput: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.controlBorder,
    backgroundColor: theme.colors.surfaceRaised,
    paddingHorizontal: 12,
    fontSize: 14,
    color: theme.colors.text,
  },
  hostSave: {
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
    overflow: "hidden",
  },
  hostSaveText: { fontSize: 13, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase", color: theme.colors.bg },
});
