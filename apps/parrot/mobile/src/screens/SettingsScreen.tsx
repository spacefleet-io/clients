// Settings, the same rows as the desktop's Account and Settings pages (PAR-NAV-01): who is signed in, the plan and
// storage (read only: no payment on a phone, ACCT-PAY-02; the phones' shared panel), pairing a device, who is listening (profiles, ACCT-PROF-01), the app's language,
// Even out volume (off by default: songs play as recorded, PAR-PLAY-03), a message to the team (with the
// error log when ticked), error reports, loading the library again, sign out (which stops the music and removes
// the library and key from the phone) and delete the account (ACCT-DEL-01: a phone that creates accounts deletes them).
// Feedback and error reports are the phone apps' shared basis (REL-FAM-03).
import React, { useEffect, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { MobileAccountPlanPanel } from "@space/mobile-shell/account-plan-panel";
import {
  MobileCreditsPanel,
  MobileErrorReportsLink,
  MobileOpenSourceNotice,
  MobileButton,
  SkyCover,
  useSkyScroll,
} from "@space/mobile-shell/components";
import { MobileFeedbackForm } from "@space/mobile-shell/feedback-form";
import { getCurrentLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { MobileChoiceList } from "@space/mobile-shell/setup-step";
import { MobileFlag } from "@space/mobile-shell/flag";
import { pickSignedInLanguage } from "../lib/accountLanguage";
import { readErrorLog, scopeLogger } from "@space/mobile-shell/logger";
import { getErrorReportsSetting, setErrorReports, subscribeErrorReportsSetting } from "../lib/errorReports";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";
import { PARROT_EVEN_VOLUME_LEVELS, type ParrotEvenVolume } from "@space/parrot-core";
import { getEvenVolume, setEvenVolume, subscribeEvenVolume } from "../lib/evenVolume";
import { parrotFeedbackDevice, sendParrotFeedback } from "../lib/feedback";
import { useProfiles } from "../lib/profiles";
import { parrotCreditsSource } from "../lib/lookup";
import { useSession } from "../state/session";
import { useSignOut } from "../state/useSignOut";
import { colors, spacing } from "../theme";
import { Body } from "./ui";
import type { RootStack } from "./routes";
import { SelfUpdateSettings } from "@space/mobile-self-update";

const log = scopeLogger("settings");

/**
 * REL-LOG-06: off until the user turns it on here; flipping it starts or stops reporting at once. Only in a build that
 * can send reports: a build with no reporting address shows no switch (issue #2570).
 */
const ErrorReportsSwitch = () => {
  const { t } = useTranslation();
  const [on, setOn] = useState(() => getErrorReportsSetting().errorReports);
  useEffect(() => subscribeErrorReportsSetting(() => setOn(getErrorReportsSetting().errorReports)), []);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Body>{t("settings.privacy.errorReports.title")}</Body>
        <Body muted>{t("settings.privacy.errorReports.description")}</Body>
        <MobileErrorReportsLink testID="settings-error-reports-link" />
      </View>
      <Switch
        accessibilityLabel={t("settings.privacy.errorReports.title")}
        value={on}
        onValueChange={(next) => {
          setErrorReports(next).catch((error: unknown) => log.warn("error_reports.save_failed", { message: error instanceof Error ? error.message : String(error) }));
        }}
      />
    </View>
  );
};

/** PAR-PLAY-03 item 2: off (songs play as recorded) until turned on; the level picker shows only while it is on. */
const EvenVolumeSetting = () => {
  const { t } = useTranslation();
  const [setting, setSetting] = useState(() => getEvenVolume());
  useEffect(() => subscribeEvenVolume(() => setSetting(getEvenVolume())), []);
  const save = (next: ParrotEvenVolume) =>
    setEvenVolume(next).catch((error: unknown) => log.warn("even_volume.save_failed", { message: error instanceof Error ? error.message : String(error) }));
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <Body muted>{t("shell.settings.evenVolumeBody")}</Body>
        </View>
        <Switch
          testID="settings-even-volume-switch"
          accessibilityLabel={t("shell.settings.evenVolume")}
          value={setting.on}
          onValueChange={(on) => void save({ ...setting, on })}
        />
      </View>
      {setting.on ? (
        <View style={{ gap: spacing.sm }}>
          <Body>{t("shell.settings.evenVolumeLevel")}</Body>
          <Body muted>{t("shell.settings.evenVolumeLevelBody")}</Body>
          <MobileChoiceList
            testID="settings-even-volume-level"
            choices={PARROT_EVEN_VOLUME_LEVELS.map((level) => ({ value: level, label: t(`shell.settings.evenVolumeLevels.${level}`) }))}
            selected={setting.level}
            onSelect={(level) => void save({ ...setting, level })}
          />
        </View>
      ) : null}
    </View>
  );
};

/**
 * UX-I18N-01: the languages, the same list as the setup's first step. UX-I18N-07: shown on this phone at once and saved
 * as the account's one language, for every app, profile and email.
 */
const LanguageChoice = () => {
  const { t } = useTranslation();
  const token = useSession().session?.token ?? null;
  const [language, setLanguage] = useState(() => getCurrentLanguage());
  return (
    <View style={{ gap: spacing.sm }}>
      <Body muted>{t("shell.settings.languageBody")}</Body>
      <MobileChoiceList
        testID="settings-language-list"
        choices={MOBILE_UI_LANGUAGES.map((option) => ({ value: option.code, label: option.nativeName, lead: <MobileFlag code={option.code} /> }))}
        selected={language}
        onSelect={(code) => {
          setLanguage(code);
          pickSignedInLanguage(token, code).catch((error: unknown) => log.warn("language.save_failed", { message: error instanceof Error ? error.message : String(error) }));
        }}
      />
    </View>
  );
};

/** One card of rows, titled like the desktop's settings sections. */
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={{ gap: spacing.sm }}>
    <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
    <SkyCover style={styles.card}>{children}</SkyCover>
  </View>
);

/** Who is listening, a one-tap switch and the profile manager (ACCT-PROF-01, UX-PROF-01), like Badger's phone. */
const ProfilesSection = ({ onOpen }: { onOpen: (mode: "pick" | "manage") => void }) => {
  const { t } = useTranslation();
  const { profiles, activeId } = useProfiles();
  const active = profiles.find((profile) => profile.id === activeId) ?? null;
  return (
    <Section title={t("profiles.settingsGroup")}>
      {active ? (
        <View testID="settings-profile-active">
          <Body muted>{t("profiles.listeningAs", { name: active.name })}</Body>
        </View>
      ) : null}
      {profiles.length > 1 ? (
        <MobileButton testID="settings-profile-switch" label={t("profiles.switch")} variant="secondary" onPress={() => onOpen("pick")} />
      ) : null}
      <MobileButton testID="settings-profiles-manage" label={t("profiles.manage")} variant="secondary" onPress={() => onOpen("manage")} />
    </Section>
  );
};

export const SettingsScreen = () => {
  const { session, reloadLibrary } = useSession();
  const signOut = useSignOut();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack, "Main">>();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const skyScroll = useSkyScroll();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" {...skyScroll}>
      {/* No page title: the tab bar names the page (PAR-NAV-04). */}
      <Section title={t("shell.settings.section.account")}>
        <View style={styles.row} testID="settings-signed-in">
          <Body muted>{t("shell.account.signedInAs", { email: "" }).trim()}</Body>
          <Text style={styles.value} numberOfLines={1}>
            {session?.user.email}
          </Text>
        </View>
        {/* ACCT-PAIR-01: this phone approves a new device (a browser on the Parrot web player, a computer, a TV). */}
        <View style={{ gap: spacing.xs }}>
          <MobileButton
            testID="settings-pair-device"
            label={t("settings.account.pairDevice.title")}
            variant="secondary"
            onPress={() => navigation.navigate("PairDevice")}
          />
          <Body muted>{t("parrot.settings.pairDeviceDescription")}</Body>
        </View>
        {/* ACCT-DEL-01: Settings > Account > Delete account, the same path as on Badger's phone. */}
        <MobileButton
          testID="settings-delete-account"
          label={t("settings.account.deleteAccount")}
          variant="secondary"
          onPress={() => navigation.navigate("DeleteAccount")}
        />
      </Section>
      {/* The plan, its state and storage, as on Badger's phone (REL-FAM-03); founder badge included (WAIT-FOUND-04). */}
      {session ? <MobileAccountPlanPanel token={session.token} Group={Section} /> : null}
      <ProfilesSection onOpen={(mode) => navigation.navigate("Profiles", { mode })} />
      <Section title={t("parrot.settings.language")}>
        <LanguageChoice />
      </Section>
      <Section title={t("shell.settings.evenVolume")}>
        <EvenVolumeSetting />
      </Section>
      {session ? (
        <Section title={t("feedback.entry")}>
          <Body muted>{t("shell.settings.feedbackBody")}</Body>
          <MobileFeedbackForm
            device={parrotFeedbackDevice()}
            readLog={readErrorLog}
            send={(body) => sendParrotFeedback(session.token, body)}
            onOutcome={(outcome, details) => log.info("feedback.outcome", { outcome, ...details })}
          />
        </Section>
      ) : null}
      <Section title={t("parrot.settings.library")}>
        <Body muted>{t("shell.settings.refreshBody")}</Body>
        <MobileButton
          testID="settings-refresh"
          label={t("parrot.settings.refresh")}
          variant="secondary"
          loading={refreshing}
          onPress={async () => {
            setRefreshing(true);
            try {
              await reloadLibrary();
            } finally {
              setRefreshing(false);
            }
          }}
        />
        {/* OFFL-MANAGE-01: what is kept on this phone, its size, remove one or all. */}
        <View style={{ gap: spacing.xs }}>
          <MobileButton
            testID="settings-offline-content"
            label={t("offlineContent.entry")}
            variant="secondary"
            onPress={() => navigation.navigate("OfflineContent")}
          />
          <Body muted>{t("offlineContent.parrot.entryDescription")}</Body>
        </View>
        {errorReportsOffered() ? <ErrorReportsSwitch /> : null}
      </Section>
      {/* REL-UPD-06: on a hand-installed APK, the version and its updates (nothing when a store manages the app). */}
      <SelfUpdateSettings language={getCurrentLanguage()} />
      {/* Third-party code shipped in the app, with its licence (Apache-2.0 attribution of the ALAC decoder), then the outside
          data sources (UX-SET-02): the app's one credits place, opened by its own GPL-3.0 line and source link (UX-SET-03). */}
      <Section title={t("parrot.settings.openSource")}>
        <MobileOpenSourceNotice language={getCurrentLanguage()} product="parrot" openLinks style={styles.openSource} />
        <Body muted>{t("parrot.settings.openSourceBody")}</Body>
        <MobileCreditsPanel language={getCurrentLanguage()} product="parrot" source={parrotCreditsSource} openLinks />
      </Section>
      <MobileButton
        label={t("parrot.settings.signOut")}
        variant="danger"
        loading={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await signOut();
          } finally {
            setBusy(false);
          }
        }}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl, gap: spacing.xl },
  sectionTitle: { color: colors.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 1.2 },
  openSource: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  card: {
    backgroundColor: "rgba(22, 27, 38, 0.92)",
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  value: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "right" },
});
