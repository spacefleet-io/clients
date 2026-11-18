import React, { memo } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Check } from "lucide-react-native";
import { fillSubtitleFetchCopy, type SubtitleFetchEntry } from "@space/shared/subtitleFetch";
import {
  subtitleFetchEntryPickable,
  subtitleFetchProgressLine,
  useSubtitleFetchFlow,
  type SubtitleFetchFlowInput,
} from "@space/shared/subtitleFetchFlow";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TvFocusable } from "../tv/components/TvFocusable";
import { theme } from "../theme/theme";

export type SubtitleFetchPanelProps = {
  input: SubtitleFetchFlowInput;
  /** The phone has no connection: nothing is searched (PLAY-SUBGET-12). */
  offline: boolean;
  onAdded?: (entry: SubtitleFetchEntry) => void;
  onClose: () => void;
  /** The player closes "added" by itself and resumes (PLAY-SUBGET-02); the details sheet waits for Done. */
  autoCloseAfterAddedMs?: number;
};

/**
 * A button of the subtitle panels: a plain Pressable on phones; on TV a focus-ringed `TvFocusable` the remote's D-pad
 * reaches, `preferFocus` taking the focus when it appears (PLAY-SUBGET-02 on the TV player).
 */
export const SubtitlePanelButton = ({
  preferFocus,
  style,
  ...rest
}: Omit<PressableProps, "style" | "children"> & { style?: StyleProp<ViewStyle>; preferFocus?: boolean; children?: React.ReactNode }) =>
  IS_TV ? (
    <TvFocusable {...rest} style={style} scale={1} ring="inside" hasTVPreferredFocus={preferFocus} />
  ) : (
    <Pressable {...rest} style={style} />
  );

/**
 * "Get subtitles" on the phone and the TV (PLAY-SUBGET-01, -02, -05): the steps of the shared flow
 * (`useSubtitleFetchFlow`, also behind the computer app's and the web page's dialog) drawn with React Native views.
 * Shown in a sheet from the details page and over the paused video from the player's subtitle menu.
 */
export const SubtitleFetchPanel = memo(({ input, offline, onAdded, onClose, autoCloseAfterAddedMs }: SubtitleFetchPanelProps) => {
  const { view, copy, pick, done, credit } = useSubtitleFetchFlow({ ...input, offline, onAdded, onClose, autoCloseAfterAddedMs });

  const back = (preferFocus: boolean) => (
    <SubtitlePanelButton
      testID="subtitle-fetch-back"
      style={styles.secondary}
      onPress={onClose}
      accessibilityRole="button"
      preferFocus={preferFocus}
    >
      <Text style={styles.secondaryText}>{copy.back}</Text>
    </SubtitlePanelButton>
  );

  let body: React.ReactNode;
  if (view.step === "offline") {
    body = (
      <>
        <Text testID="subtitle-fetch-offline" style={styles.muted}>
          {copy.offline}
        </Text>
        {back(true)}
      </>
    );
  } else if (view.step === "looking") {
    body = (
      <View testID="subtitle-fetch-looking" style={styles.busy}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.text}>{copy.looking}</Text>
      </View>
    );
  } else if (view.step === "none" || view.step === "unavailable") {
    body = (
      <>
        <Text testID={`subtitle-fetch-${view.step}`} style={styles.text}>
          {view.step === "none" ? copy.none : copy.unavailable}
        </Text>
        {back(true)}
      </>
    );
  } else if (view.step === "list" || view.step === "failed") {
    const entries = view.entries;
    // The TV remote lands on the first subtitle it can fetch, else on Back.
    const firstPickable = entries.find(subtitleFetchEntryPickable)?.key ?? null;
    body = (
      <>
        {view.step === "failed" ? (
          <Text testID="subtitle-fetch-failed" style={styles.error} accessibilityRole="alert">
            {fillSubtitleFetchCopy(copy.failed, { name: view.entry.name })}
          </Text>
        ) : null}
        <Text style={styles.muted}>{copy.pick}</Text>
        <ScrollView testID="subtitle-fetch-list" style={styles.listScroll} contentContainerStyle={styles.list}>
          {entries.map((entry) => {
            // A subtitle fetched before is never fetched a second time (PLAY-SUBGET-18).
            const pickable = subtitleFetchEntryPickable(entry);
            return (
              <SubtitlePanelButton
                key={entry.key}
                testID="subtitle-fetch-entry"
                accessibilityRole="button"
                accessibilityLabel={entry.already ? `${entry.name}, ${copy.already}` : entry.name}
                accessibilityState={{ disabled: !pickable }}
                disabled={!pickable}
                focusable={pickable}
                preferFocus={entry.key === firstPickable}
                onPress={() => pick(entry, entries)}
                style={[styles.row, !pickable && styles.rowDisabled]}
              >
                <Text style={styles.rowName}>{entry.name}</Text>
                {entry.already ? (
                  <Text testID="subtitle-fetch-already" style={styles.note}>
                    {copy.already}
                  </Text>
                ) : null}
              </SubtitlePanelButton>
            );
          })}
        </ScrollView>
        {credit ? (
          <Text testID="subtitle-fetch-credit" style={styles.note}>
            {credit.text}{" "}
            {IS_TV ? (
              // No browser on the TV: the name is shown, not linked.
              <Text style={styles.creditName}>{credit.name}</Text>
            ) : (
              <Text style={styles.creditName} accessibilityRole="link" onPress={() => void Linking.openURL(credit.url)}>
                {credit.name}
              </Text>
            )}
          </Text>
        ) : null}
        {back(firstPickable === null)}
      </>
    );
  } else if (view.step === "progress") {
    const line = subtitleFetchProgressLine(copy, view.entry, view.stage);
    body = (
      <View testID="subtitle-fetch-progress" style={styles.busy} accessibilityLiveRegion="polite">
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.text}>{line}</Text>
      </View>
    );
  } else {
    body = (
      <>
        <View testID="subtitle-fetch-added" style={styles.busy} accessibilityLiveRegion="polite">
          <Check size={20} color={theme.colors.accent} />
          <Text style={styles.text}>{fillSubtitleFetchCopy(copy.added, { name: view.entry.trackName })}</Text>
        </View>
        {autoCloseAfterAddedMs === undefined ? (
          <SubtitlePanelButton testID="subtitle-fetch-done" style={styles.primary} onPress={done} accessibilityRole="button" preferFocus>
            <Text style={styles.primaryText}>{copy.done}</Text>
          </SubtitlePanelButton>
        ) : null}
      </>
    );
  }

  return (
    <View testID="subtitle-fetch" style={styles.panel}>
      <Text style={styles.title} accessibilityRole="header">
        {copy.title}
      </Text>
      {body}
    </View>
  );
});
SubtitleFetchPanel.displayName = "SubtitleFetchPanel";

/** The look of the subtitle panels, shared with the player's "Try another version" panel (PLAY-SUBGET-07). */
export const subtitlePanelStyles = StyleSheet.create({
  panel: { gap: 10 },
  title: { color: theme.colors.text, fontSize: 16, fontWeight: "800", fontFamily: theme.font.family.display },
  text: { color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: theme.colors.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: theme.colors.danger, fontSize: 13, lineHeight: 19 },
  busy: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 18 },
  listScroll: { maxHeight: 360 },
  list: { gap: 8, paddingBottom: 4 },
  row: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowDisabled: { opacity: 0.55 },
  rowName: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  note: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
  creditName: { textDecorationLine: "underline" },
  secondary: {
    alignSelf: "flex-end",
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  secondaryText: { color: theme.colors.text, fontSize: 14, fontWeight: "700" },
  primary: {
    alignSelf: "flex-end",
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: theme.colors.accent,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryText: { color: theme.colors.bg, fontSize: 14, fontWeight: "800" },
});
const styles = subtitlePanelStyles;
