import React, { memo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Check } from "lucide-react-native";
import {
  fillSubtitleFetchCopy,
  subtitleTitleMatchLabel,
  type SubtitleFetchCopy,
  type SubtitleFetchEntry,
  type SubtitleTitleMatch,
} from "@space/shared/subtitleFetch";
import {
  subtitleFetchEntryPickable,
  subtitleFetchProgressLine,
  useSubtitleFetchFlow,
  type SubtitleFetchFlowInput,
} from "@space/shared/subtitleFetchFlow";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
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
  const { view, copy, pick, findTitle, pickTitle, done, credit } = useSubtitleFetchFlow({ ...input, offline, onAdded, onClose, autoCloseAfterAddedMs });
  // The title last looked up, so "Search another title" after a pick reopens the title step with it (PLAY-SUBGET-24).
  const lastTitle = useRef(input.findTitle?.query ?? "");
  if (view.step === "title") lastTitle.current = view.query;

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
  } else if (view.step === "title") {
    body = (
      <SubtitleTitleStep key={view.query} query={view.query} matches={view.matches} copy={copy} onFind={findTitle} onPick={pickTitle} back={back} />
    );
  } else if (view.step === "none" || view.step === "unavailable") {
    // No subtitles for the film or show picked by title: another title may be the right one (PLAY-SUBGET-24).
    const otherTitle = view.step === "none" && input.findTitle !== undefined;
    body = (
      <>
        <Text testID={`subtitle-fetch-${view.step}`} style={styles.text}>
          {view.step === "none" ? copy.none : copy.unavailable}
        </Text>
        {otherTitle ? (
          <SubtitlePanelButton
            testID="subtitle-fetch-other-title"
            style={styles.primary}
            onPress={() => findTitle(lastTitle.current)}
            accessibilityRole="button"
            preferFocus
          >
            <Text style={styles.primaryText}>{copy.otherTitle}</Text>
          </SubtitlePanelButton>
        ) : null}
        {back(!otherTitle)}
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

/**
 * The title step (PLAY-SUBGET-24): the media has no catalog id, so the user names the film or show first. The field starts
 * with the title the app shows; the matches of the metadata service's title search are rows (the TV remote lands on the
 * first, else on Search; the field opens the TV keyboard). Nothing found: `noTitle`, with the field to try again.
 */
const SubtitleTitleStep = ({
  query,
  matches,
  copy,
  onFind,
  onPick,
  back,
}: {
  query: string;
  matches: SubtitleTitleMatch[] | null;
  copy: SubtitleFetchCopy;
  onFind: (query: string) => void;
  onPick: (match: SubtitleTitleMatch) => void;
  back: (preferFocus: boolean) => React.ReactNode;
}) => {
  const [text, setText] = useState(query);
  const [fieldFocused, setFieldFocused] = useState(false);
  const find = () => {
    console.info("subtitle_fetch.title.find", JSON.stringify({ length: text.trim().length }));
    onFind(text);
  };
  return (
    <>
      <Text style={styles.muted}>{copy.titlePrompt}</Text>
      <View style={styles.titleRow}>
        {/* A plain field, not wrapped in a focusable: the wrapper would take the focus and the TV keyboard would not
            open (UX-TV-16). Its own ring shows the focus. */}
        <TextInput
          testID="subtitle-fetch-title-field"
          style={[styles.field, fieldFocused && styles.fieldFocused]}
          value={text}
          onChangeText={setText}
          onSubmitEditing={find}
          placeholder={copy.titleField}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={copy.titleField}
          autoCorrect={false}
          returnKeyType="search"
          onFocus={() => setFieldFocused(true)}
          onBlur={() => setFieldFocused(false)}
        />
        <SubtitlePanelButton
          testID="subtitle-fetch-title-search"
          style={styles.primary}
          onPress={find}
          accessibilityRole="button"
          preferFocus={matches !== null && matches.length === 0}
        >
          <Text style={styles.primaryText}>{copy.titleSearch}</Text>
        </SubtitlePanelButton>
      </View>
      {matches === null ? (
        <View testID="subtitle-fetch-title-finding" style={styles.busy}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text style={styles.text}>{fillSubtitleFetchCopy(copy.findingTitle, { title: query })}</Text>
        </View>
      ) : matches.length === 0 ? (
        <Text testID="subtitle-fetch-no-title" style={styles.text}>
          {fillSubtitleFetchCopy(copy.noTitle, { title: query })}
        </Text>
      ) : (
        <ScrollView testID="subtitle-fetch-title-list" style={styles.listScroll} contentContainerStyle={styles.list}>
          {matches.map((match, index) => {
            const label = subtitleTitleMatchLabel(match);
            return (
              <SubtitlePanelButton
                key={match.catalogId}
                testID="subtitle-fetch-title-match"
                accessibilityRole="button"
                accessibilityLabel={label}
                preferFocus={index === 0}
                onPress={() => {
                  console.info("subtitle_fetch.title.pick", JSON.stringify({ catalogId: match.catalogId, index }));
                  onPick(match);
                }}
                style={styles.row}
              >
                <Text style={styles.rowName}>{label}</Text>
              </SubtitlePanelButton>
            );
          })}
        </ScrollView>
      )}
      {back(false)}
    </>
  );
};

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
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  field: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontSize: 14,
    paddingHorizontal: 12,
  },
  fieldFocused: { borderColor: theme.colors.accent, borderWidth: 2 },
});
const styles = subtitlePanelStyles;
