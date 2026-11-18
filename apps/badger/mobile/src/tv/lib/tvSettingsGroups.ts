import { Globe, Info, Mail, Play, Shield, User, type LucideIcon } from "lucide-react-native";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";

/**
 * UX-TV-42: TV Settings' groups, in the left column's order (approved mockup `tv-settings`, Chris 2026-11-12 (chat)).
 * Pure, so the order and the remembered group are testable without a TV.
 */
export type TvSettingsGroupId = "profiles" | "account" | "playback" | "privacy" | "language" | "about";

export type TvSettingsGroup = { id: TvSettingsGroupId; labelKey: string; icon: LucideIcon };

export const TV_SETTINGS_GROUPS: readonly TvSettingsGroup[] = [
  { id: "profiles", labelKey: "profiles.settingsGroup", icon: User },
  { id: "account", labelKey: "settings.account.title", icon: Mail },
  { id: "playback", labelKey: "settings.playback.title", icon: Play },
  { id: "privacy", labelKey: "settings.privacy.title", icon: Shield },
  { id: "language", labelKey: "settings.language.title", icon: Globe },
  { id: "about", labelKey: "tvShell.settings.about", icon: Info },
];

/**
 * The groups this build shows: Privacy holds only the "Send error reports" switch, so a build that cannot send reports
 * (no reporting address: REL-LOG-06, issue #2570) has no Privacy group.
 */
export const tvSettingsGroups = (): readonly TvSettingsGroup[] =>
  errorReportsOffered() ? TV_SETTINGS_GROUPS : TV_SETTINGS_GROUPS.filter(({ id }) => id !== "privacy");

/** The group Settings opens on the first time in an app session (the mockup's focus starts on Playback's first row). */
export const TV_SETTINGS_FIRST_GROUP: TvSettingsGroupId = "playback";

let lastOpened: TvSettingsGroupId = TV_SETTINGS_FIRST_GROUP;

/** The group Settings opens on: the one last opened in this app session (Settings remounts after a profile switch). */
export const tvSettingsOpenGroup = (): TvSettingsGroupId => lastOpened;

export const rememberTvSettingsGroup = (group: TvSettingsGroupId): void => {
  lastOpened = group;
};

/** Test-only: a new app session. */
export const resetTvSettingsGroup = (): void => {
  lastOpened = TV_SETTINGS_FIRST_GROUP;
};
