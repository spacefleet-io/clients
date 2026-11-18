import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { MobileButtonFace } from "@space/mobile-shell/button-face";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { checkForUpdate, setAutoUpdate, startUpdate, useSelfUpdate } from "./controller";
import { selfUpdateText, type SelfUpdateStringKey } from "./strings";

type SelfUpdateSettingsProps = {
  language: string | undefined;
  /** Text scale (the TV passes its screen scale). */
  scale?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * REL-UPD-06: Settings › About on a hand-installed Android app, phone and TV alike: the version, what the last check
 * found, "Update automatically" (on by default) and a button to check or update now. An installer we don't know gets
 * only the line saying a new version exists. Nothing at all when a store manages the install. Every control is a
 * plain focusable row, so the TV remote moves through it.
 */
export const SelfUpdateSettings = ({ language, scale = 1, style }: SelfUpdateSettingsProps) => {
  const theme = useMobileShellTheme();
  const { app, installed, manager, newest, offer, autoUpdate, consentPending, phase } = useSelfUpdate();
  const [toggleFocused, setToggleFocused] = useState(false);
  // The consent step covers the app until answered; nothing to show behind it.
  if (!app || !installed || !manager || manager === "managed" || consentPending) return null;
  const tv = Platform.isTV === true;
  const name = app === "badger" ? "Badger" : "Parrot";
  const text = (key: SelfUpdateStringKey) => selfUpdateText(language, key, { app: name, version: newest?.versionName ?? installed.versionName });

  const status =
    phase.kind === "checking"
      ? text("checking")
      : phase.kind === "error" && !newest
        ? text("errorNetwork")
        : offer === "info"
          ? text("availableElsewhere")
          : offer === "prompt" || offer === "offer"
            ? text("available")
            : newest
              ? text("upToDate")
              : null;
  const canUpdate = manager === "unmanaged" && (offer === "prompt" || offer === "offer");
  const body = { color: theme.colors.text, fontFamily: theme.font.family.sans, fontSize: 15 * scale };
  const muted = { color: theme.colors.textMuted, fontFamily: theme.font.family.sans, fontSize: 13 * scale, lineHeight: 19 * scale };

  return (
    <View style={[styles.panel, { gap: 10 * scale }, style]} testID="self-update-settings">
      <Text style={muted} testID="self-update-version">
        {selfUpdateText(language, "version", { version: installed.versionName })}
        {status ? ` · ${status}` : ""}
      </Text>
      {manager === "unmanaged" ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: autoUpdate }}
          accessibilityLabel={text("autoLabel")}
          onPress={() => void setAutoUpdate(!autoUpdate)}
          onFocus={() => setToggleFocused(true)}
          onBlur={() => setToggleFocused(false)}
          style={[styles.toggle, { borderColor: tv && toggleFocused ? theme.colors.accent : "transparent", borderRadius: 12 * scale }]}
          testID="self-update-auto"
        >
          <View style={styles.toggleText}>
            <Text style={body}>{text("autoLabel")}</Text>
            <Text style={muted}>{text("autoHint")}</Text>
          </View>
          <Switch value={autoUpdate} onValueChange={(value) => void setAutoUpdate(value)} focusable={false} />
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        {canUpdate ? (
          <MobileButtonFace label={text("update")} onPress={() => void startUpdate()} testID="self-update-now" />
        ) : (
          <MobileButtonFace
            label={text("check")}
            variant="secondary"
            loading={phase.kind === "checking"}
            disabled={phase.kind === "checking"}
            onPress={() => void checkForUpdate({ quiet: true })}
            testID="self-update-check"
          />
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  panel: { paddingHorizontal: 16, paddingVertical: 12 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 2, padding: 4 },
  toggleText: { flex: 1, gap: 2 },
  actions: { flexDirection: "row" },
});
