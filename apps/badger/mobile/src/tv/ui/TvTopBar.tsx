import React, { memo, useState, type ReactNode } from "react";
import { Image, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { Home, Library, ListVideo, Search, Settings, type LucideIcon } from "lucide-react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { TvFocusable } from "../components/TvFocusable";
import { TV_SAFE_MARGIN_Y } from "../lib/layout";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import type { TvSectionId } from "../lib/tvSection";
import { TvIconButton } from "./TvPillButton";
import { TV_COLOR, TV_FONT, TV_RADII, TV_SPACE } from "./tokens";

const BADGER_ICON = require("../../assets/badger-icon.png");
/** The app's name: a name, not a translated text (UX-NAME-01). */
const BRAND_NAME = "Badger";

type TvTab = { id: TvSectionId; labelKey: string; icon: LucideIcon };

/** Home, Library, Playlists and Search, centred in the bar (UX-TV-09); Playlists is a section of its own, not a Library tab. */
export const TV_BROWSE_TABS = [
  { id: "home", labelKey: "nav.home", icon: Home },
  { id: "library", labelKey: "nav.library", icon: Library },
  { id: "playlists", labelKey: "nav.playlists", icon: ListVideo },
  { id: "search", labelKey: "tvShell.nav.search", icon: Search },
] as const satisfies readonly TvTab[];
/** Settings, alone at the right end: not the same kind of menu. */
export const TV_SETTINGS_TAB = { id: "settings", labelKey: "nav.settings", icon: Settings } as const satisfies TvTab;

export type TvTopBarProps = {
  /** The open section: its tab is a dark pill with an amber icon. */
  active: TvSectionId;
  onSelect: (section: TvSectionId) => void;
  /** Shown just before Settings (the offline notice, UX-TV-14). */
  beforeSettings?: ReactNode;
  /** Tabs greyed out that the remote skips: Library and Playlists while the library is empty (UX-LIBTAB-01). */
  disabledTabs?: readonly TvSectionId[];
};

/**
 * The TV top bar (UX-TV-09, UX-TV-36, mockup `.topbar`): the Badger mark at the left, Home, Library, Playlists and Search
 * centred in spaced capitals, Settings alone at the right as an icon button. No language button and no avatar: the
 * language is set in Settings. The whole width is one focus guide, so Up from anything under the bar finds it and lands
 * on the last focused tab (TV-RAIL-FOCUS-001); left to right the focus goes Home, Library, Playlists, Search, the offline
 * notice when there is one, then Settings. A screen above the shell (the title page) shows the same bar.
 */
export const TvTopBar = memo(({ active, onSelect, beforeSettings, disabledTabs = [] }: TvTopBarProps) => {
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  const select = (id: TvSectionId) => {
    console.info("tv.nav.select", JSON.stringify({ tab: id }));
    onSelect(id);
  };
  return (
    <TVFocusGuideView autoFocus style={styles.bar} accessibilityRole="tablist" accessibilityLabel={t("tvShell.navLabel")}>
      <View style={styles.side}>
        <View style={styles.brand} testID="tv-nav-brand" accessible={false}>
          <Image source={BADGER_ICON} style={styles.brandIcon} resizeMode="contain" />
          <Text style={styles.brandName}>{BRAND_NAME}</Text>
        </View>
      </View>
      <View style={styles.tabs}>
        {TV_BROWSE_TABS.map((tab) => (
          <TopBarTab
            key={tab.id}
            tab={tab}
            label={t(tab.labelKey)}
            selected={tab.id === active}
            disabled={disabledTabs.includes(tab.id)}
            onSelect={select}
          />
        ))}
      </View>
      <View style={[styles.side, styles.end]}>
        {beforeSettings}
        <SkyCover>
          <TvIconButton
            icon={TV_SETTINGS_TAB.icon}
            selected={active === "settings"}
            onPress={() => select("settings")}
            accessibilityRole="tab"
            accessibilityLabel={t(TV_SETTINGS_TAB.labelKey)}
            accessibilityState={{ selected: active === "settings" }}
            testID="tv-nav-settings"
          />
        </SkyCover>
      </View>
    </TVFocusGuideView>
  );
});
TvTopBar.displayName = "TvTopBar";

type TopBarTabProps = { tab: TvTab; label: string; selected: boolean; disabled: boolean; onSelect: (id: TvSectionId) => void };

/** A disabled tab is shown at half opacity and is not focusable, as the TV's disabled buttons (PairingButton). */
const TopBarTab = ({ tab: { id, icon: Icon }, label, selected, disabled, onSelect }: TopBarTabProps) => {
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const [focused, setFocused] = useState(false);
  const iconColor = selected ? TV_COLOR.amber : focused ? TV_COLOR.text : TV_COLOR.muted;
  return (
    <SkyCover>
      <TvFocusable
        style={[styles.tab, selected && styles.tabSelected, disabled && styles.tabDisabled]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={() => onSelect(id)}
        focusable={!disabled}
        disabled={disabled}
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={disabled ? { selected, disabled } : { selected }}
        testID={`tv-nav-${id}`}
      >
        <Icon size={13 * scale} color={iconColor} />
        <Text style={[styles.tabLabel, (selected || focused) && styles.tabLabelOn]}>{label}</Text>
      </TvFocusable>
    </SkyCover>
  );
};

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    height: 54,
    marginTop: Math.max(0, TV_SAFE_MARGIN_Y - 27),
    paddingHorizontal: TV_SPACE.screenX,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(68, 71, 90, 0.45)",
    experimental_backgroundImage: "linear-gradient(180deg, rgba(18, 20, 33, 0.85), rgba(18, 20, 33, 0.35))",
  },
  side: { flex: 1, flexDirection: "row", alignItems: "center" },
  end: { justifyContent: "flex-end", gap: 6 },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  brandIcon: { width: 26, height: 26 },
  brandName: { fontFamily: TV_FONT.display, fontSize: 15, fontWeight: "600", color: TV_COLOR.text },
  tabs: { flexDirection: "row", alignItems: "center", gap: 5 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 13,
    borderRadius: TV_RADII.control,
    borderWidth: 0.5,
    borderColor: "transparent",
  },
  tabSelected: { backgroundColor: "rgba(36, 38, 56, 0.85)", borderColor: "rgba(68, 71, 90, 0.7)" },
  tabDisabled: { opacity: 0.5 },
  tabLabel: {
    fontFamily: TV_FONT.body,
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 10.5 * 0.12,
    textTransform: "uppercase",
    color: "rgba(182, 186, 206, 0.8)",
  },
  tabLabelOn: { color: TV_COLOR.text },
});
