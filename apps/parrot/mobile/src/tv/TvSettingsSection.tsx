// TV Settings (PAR-TV-13, agent reading, approved by Main 2026-11-20): Badger TV's two columns, the groups at the left
// (the one under the focus opens), the open group's rows at the right. Parrot's groups are the phone's, less what needs
// a keyboard or a camera: Profiles, Account (who is signed in, Sign out), Playback (Even out volume), Privacy (error
// reports, where offered), Language and About.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { ChevronRight, Globe, Info, LogOut, ShieldCheck, SlidersHorizontal, UserRound, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { MobileCreditsPanel, MobileOpenSourceNotice, useSkyScroll } from "@space/mobile-shell/components";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";
import { MobileFlag } from "@space/mobile-shell/flag";
import { getCurrentLanguage, MOBILE_UI_LANGUAGES, useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvSegmented } from "@space/mobile-shell/tv/TvChip";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { TvRow, TvRowList } from "@space/mobile-shell/tv/TvRow";
import { TvBody, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_SPACE, TV_TYPE, useTvAccent } from "@space/mobile-shell/tv/tokens";
import { focusDestination, type TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { nativeAppInfo } from "@space/mobile-media-proxy/app-info";
import { SelfUpdateSettings } from "@space/mobile-self-update";
import { PARROT_EVEN_VOLUME_LEVELS, type ParrotEvenVolume, type ParrotEvenVolumeLevel } from "@space/parrot-core";
import { pickSignedInLanguage } from "../lib/accountLanguage";
import { getErrorReportsSetting, setErrorReports, subscribeErrorReportsSetting } from "../lib/errorReports";
import { getEvenVolume, setEvenVolume, subscribeEvenVolume } from "../lib/evenVolume";
import { parrotCreditsSource } from "../lib/lookup";
import { useProfiles } from "../lib/profiles";
import { useSession } from "../state/session";
import { useSignOut } from "../state/useSignOut";
import { tvSettingsGroupIds, type TvSettingsGroupId } from "./tvModel";
import { useTvPages } from "./tvPages";

const log = scopeLogger("parrot.tv.settings");

const GROUPS: Record<TvSettingsGroupId, { labelKey: string; icon: LucideIcon }> = {
  profiles: { labelKey: "profiles.settingsGroup", icon: Users },
  account: { labelKey: "shell.settings.section.account", icon: UserRound },
  playback: { labelKey: "shell.settings.evenVolume", icon: SlidersHorizontal },
  privacy: { labelKey: "settings.privacy.errorReports.title", icon: ShieldCheck },
  language: { labelKey: "parrot.settings.language", icon: Globe },
  about: { labelKey: "tvShell.settings.about", icon: Info },
};

const LANGUAGE_OPTIONS = MOBILE_UI_LANGUAGES.map((option) => ({ value: option.code as string, label: option.nativeName, lead: <MobileFlag code={option.code} /> }));

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

const useEvenVolume = (): [ParrotEvenVolume, (next: ParrotEvenVolume) => void] => {
  const [setting, setSetting] = useState(() => getEvenVolume());
  useEffect(() => subscribeEvenVolume(() => setSetting(getEvenVolume())), []);
  const save = useCallback((next: ParrotEvenVolume) => {
    log.info("even_volume", next);
    setEvenVolume(next).catch((error: unknown) => log.warn("even_volume.save_failed", { message: failure(error) }));
  }, []);
  return [setting, save];
};

const useErrorReports = (): [boolean, (on: boolean) => void] => {
  const [on, setOn] = useState(() => getErrorReportsSetting().errorReports);
  useEffect(() => subscribeErrorReportsSetting(() => setOn(getErrorReportsSetting().errorReports)), []);
  const save = useCallback((next: boolean) => {
    log.info("error_reports", { on: next });
    setErrorReports(next).catch((error: unknown) => log.warn("error_reports.save_failed", { message: failure(error) }));
  }, []);
  return [on, save];
};

export const TvSettingsSection = () => {
  const { t, i18n } = useTranslation();
  const { session } = useSession();
  const token = session?.token ?? null;
  const signOut = useSignOut();
  const { push } = useTvPages();
  const { profiles, activeId } = useProfiles();
  const activeProfile = profiles.find((profile) => profile.id === activeId) ?? null;
  const [evenVolume, saveEvenVolume] = useEvenVolume();
  const [errorReports, saveErrorReports] = useErrorReports();
  const [language, setLanguage] = useState(() => getCurrentLanguage());
  const [signingOut, setSigningOut] = useState(false);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent().color;
  const skyScroll = useSkyScroll();

  const groups = tvSettingsGroupIds(errorReportsOffered()).map((id) => ({ id, ...GROUPS[id] }));
  const [group, setGroup] = useState<TvSettingsGroupId>("profiles");
  const groupRefs = useRef(new Map<TvSettingsGroupId, TvViewInstance>());
  // The left column's focus guide sends the focus to the open group; its node exists only after the first commit.
  const [groupsMounted, setGroupsMounted] = useState(false);
  useEffect(() => setGroupsMounted(true), []);
  const openGroup = useCallback((next: TvSettingsGroupId) => {
    setGroup((prev) => {
      if (prev !== next) log.info("group", { from: prev, to: next });
      return next;
    });
  }, []);
  const openGroupNode = groupsMounted ? (groupRefs.current.get(group) ?? null) : null;
  const openLabel = t(groups.find((item) => item.id === group)?.labelKey ?? "");

  const renderGroup = () => {
    switch (group) {
      case "profiles":
        return (
          <>
            {activeProfile ? <TvBody muted>{t("profiles.listeningAs", { name: activeProfile.name })}</TvBody> : null}
            <TvRowList>
              {profiles.length > 1 ? (
                <TvRow testID="tv-settings-profile-switch" icon={Users} title={t("profiles.switch")} end={{ kind: "chevron" }} onPress={() => push({ kind: "profiles", mode: "pick" })} />
              ) : null}
              <TvRow testID="tv-settings-profiles-manage" icon={UserRound} title={t("profiles.manage")} end={{ kind: "chevron" }} onPress={() => push({ kind: "profiles", mode: "manage" })} />
            </TvRowList>
          </>
        );
      case "account":
        return (
          <TvRowList>
            <TvRow testID="tv-settings-signed-in" icon={UserRound} title={t("shell.account.signedInAs", { email: "" }).trim()} description={session?.user.email ?? ""} end={{ kind: "none" }} focusable={false} />
            <TvRow
              testID="tv-settings-sign-out"
              icon={LogOut}
              title={t("parrot.settings.signOut")}
              danger
              disabled={signingOut}
              end={{ kind: "none" }}
              onPress={() => {
                log.info("sign_out", {});
                setSigningOut(true);
                signOut().catch((error: unknown) => {
                  log.warn("sign_out.failed", { message: failure(error) });
                  setSigningOut(false);
                });
              }}
            />
          </TvRowList>
        );
      case "playback":
        return (
          <>
            <TvRowList>
              <TvRow
                testID="tv-settings-even-volume"
                icon={SlidersHorizontal}
                title={t("shell.settings.evenVolume")}
                description={t("shell.settings.evenVolumeBody")}
                end={{ kind: "toggle", value: evenVolume.on }}
                onPress={() => saveEvenVolume({ ...evenVolume, on: !evenVolume.on })}
              />
            </TvRowList>
            {evenVolume.on ? (
              <View style={styles.block}>
                <TvBody>{t("shell.settings.evenVolumeLevel")}</TvBody>
                <TvBody muted size="caption">
                  {t("shell.settings.evenVolumeLevelBody")}
                </TvBody>
                <TvSegmented<ParrotEvenVolumeLevel>
                  testID="tv-settings-even-volume-level"
                  options={PARROT_EVEN_VOLUME_LEVELS.map((level) => ({ value: level, label: t(`shell.settings.evenVolumeLevels.${level}`) }))}
                  value={evenVolume.level}
                  onChange={(level) => saveEvenVolume({ ...evenVolume, level })}
                />
              </View>
            ) : null}
          </>
        );
      case "privacy":
        return (
          <TvRowList>
            <TvRow
              testID="tv-settings-error-reports"
              icon={ShieldCheck}
              title={t("settings.privacy.errorReports.title")}
              description={t("settings.privacy.errorReports.description")}
              end={{ kind: "toggle", value: errorReports }}
              onPress={() => saveErrorReports(!errorReports)}
            />
          </TvRowList>
        );
      case "language":
        return (
          <View style={styles.block}>
            <TvBody muted>{t("shell.settings.languageBody")}</TvBody>
            <TvSegmented
              testID="tv-settings-language"
              options={LANGUAGE_OPTIONS}
              value={language}
              onChange={(code) => {
                log.info("language", { from: i18n.language, to: code });
                setLanguage(code);
                pickSignedInLanguage(token, code).catch((error: unknown) => log.warn("language.save_failed", { message: failure(error) }));
              }}
            />
          </View>
        );
      case "about":
        return (
          <View style={styles.about}>
            {nativeAppInfo().version ? (
              <TvBody muted testID="tv-settings-version">
                {`Parrot ${nativeAppInfo().version}`}
              </TvBody>
            ) : null}
            <SelfUpdateSettings language={i18n.language} scale={scale} />
            <MobileOpenSourceNotice language={i18n.language} product="parrot" openLinks={false} scale={scale} />
            <MobileCreditsPanel language={i18n.language} product="parrot" source={parrotCreditsSource} openLinks={false} scale={scale} />
          </View>
        );
    }
  };

  return (
    <View style={styles.columns}>
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
              <Icon size={15 * scale} color={selected ? accent : TV_COLOR.muted} />
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
        <ScrollView style={styles.pane} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} {...skyScroll}>
          <TvTitle size="page">{openLabel}</TvTitle>
          {renderGroup()}
        </ScrollView>
      </TVFocusGuideView>
    </View>
  );
};

/** Sizes in design dp: Badger TV's settings mockup px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  columns: { flex: 1, flexDirection: "row", gap: 24, paddingTop: 22, paddingHorizontal: TV_SPACE.screenX },
  groups: { width: 260, gap: 4 },
  group: { flexDirection: "row", alignItems: "center", gap: 10, height: 42, paddingHorizontal: 12, borderRadius: 8, borderWidth: 0.75, borderColor: "transparent" },
  groupSelected: { backgroundColor: TV_COLOR.cardOnSky, borderColor: TV_COLOR.borderSoft },
  groupLabel: { flex: 1, fontFamily: TV_TYPE.body.fontFamily, fontSize: 13.5, fontWeight: "600", color: TV_COLOR.muted },
  groupLabelSelected: { color: TV_COLOR.text },
  pane: { flex: 1 },
  content: { gap: 11, paddingBottom: 44 },
  block: { gap: 8 },
  about: { gap: 14 },
});
