// The phone's lyrics editor (PAR-LYR-10, Chris 2026-11-27), the desktop's `ParrotLyricsEditorDialog` drawn for a phone as
// two full pages: the words page (paste or type them, then "Time the lyrics" or "Save the words") and the timing page
// (tap as each line starts, nudge it 0.1 s, replay a line; Back returns to the words, times kept). Saved as synced
// lyrics when every line is timed, else as plain words. Reading the words, the times and what is saved are the
// shared helpers of @space/parrot-core; only the drawing is the phone's. The TV has no editor.
import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Minus, Plus } from "lucide-react-native";
import { AudioPlayback } from "@space/mobile-audio-playback";
import { MobileButton, MobileIconButton } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { KeyboardAvoidingForm, useKeyboardOpen } from "@space/mobile-shell/keyboard";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import {
  clearParrotEditorTimes,
  nudgeParrotEditorLine,
  parrotEditorLines,
  parrotEditorLinesText,
  parrotEditorText,
  saveParrotEditorLyrics,
  tapParrotEditorLine,
  type ParrotEditorLine,
  type ParrotLyrics,
  type ParrotOwnLyrics,
} from "@space/parrot-core";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing } from "../theme";

const NUDGE_MS = 100;

const lineTime = (ms: number) => {
  const total = Math.floor(ms / 10);
  const minutes = Math.floor(total / 6000);
  const seconds = Math.floor((total % 6000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
};

export const LyricsEditor = ({
  open,
  title,
  lyrics,
  playing,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The song's title, named in the editor's heading. */
  title: string;
  /** The song's lyrics now: the words the editor starts from. */
  lyrics: ParrotLyrics | null;
  playing: boolean;
  onClose: () => void;
  /** Rejects when the save failed: the editor stays open and says so. */
  onSave: (lyrics: ParrotOwnLyrics) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  // While the keyboard is up the form pads by everything it covers, navigation bar included (and the insets measured
  // inside the lyrics sheet then count the keyboard too), so the page keeps only its own margin.
  const pageBottom = { paddingBottom: (keyboardOpen ? 0 : insets.bottom) + spacing.sm };
  const [text, setText] = useState("");
  const [timing, setTiming] = useState(false);
  const [lines, setLines] = useState<ParrotEditorLine[]>([]);
  const [current, setCurrent] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(parrotEditorText(lyrics));
    setTiming(false);
    setProblem(null);
    setSaving(false);
    // The words are read when the editor opens, not again while the user edits them.
  }, [open]);

  const startTiming = () => {
    const next = parrotEditorLines(text);
    setLines(next);
    const untimed = next.findIndex((line) => line.ms === null);
    setCurrent(untimed === -1 ? 0 : untimed);
    setProblem(null);
    setTiming(true);
  };
  // Back to the words page: the words carry the times, so timing again starts where the user left off.
  const back = () => {
    setText(parrotEditorLinesText(lines));
    setProblem(null);
    setTiming(false);
  };
  const tap = async () => {
    if (lines.length === 0) return;
    // The player's position at the tap itself, not the sheet's last poll.
    const { positionMs } = await AudioPlayback.getState();
    setLines((now) => tapParrotEditorLine(now, current, positionMs));
    setCurrent(Math.min(current + 1, lines.length - 1));
    setProblem(null);
  };
  const save = async (words: string) => {
    const result = saveParrotEditorLyrics(words);
    if (!result.ok) {
      setProblem(t(`shell.lyricsProblem.${result.problem.kind}`, "line" in result.problem ? { line: result.problem.line } : {}));
      if (timing && "line" in result.problem) setCurrent(result.problem.line - 1);
      return;
    }
    setSaving(true);
    try {
      await onSave(result.lyrics);
      onClose();
    } catch {
      setProblem(t("shell.lyricsEditor.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const timed = lines.filter((line) => line.ms !== null).length;
  const currentMs = lines[current]?.ms ?? null;
  const problemLine = problem && (
    <Text style={styles.problem} accessibilityRole="alert" testID="lyrics-editor-problem">
      {problem}
    </Text>
  );

  return (
    <Modal visible={open} animationType="slide" statusBarTranslucent onRequestClose={timing ? back : onClose}>
      {/* UX-CRASH-01: a crash inside the editor closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:lyrics-editor" onDismiss={onClose}>
        {/* The form's own bottom padding is the stretch the keyboard covers while it is up; the gesture bar's room otherwise goes on the page. */}
        <KeyboardAvoidingForm translucentModal style={[styles.screen, { paddingTop: insets.top + spacing.sm }]}>
          {timing ? (
            <View style={[styles.page, pageBottom]} testID="lyrics-editor-timing">
              <View style={styles.header}>
                <MobileButton testID="lyrics-editor-back" variant="ghost" style={styles.inline} label={t("shell.lyricsEditor.back")} onPress={back} />
                <MobileButton
                  testID="lyrics-editor-save"
                  style={styles.inline}
                  label={t("shell.lyricsEditor.save")}
                  disabled={saving}
                  onPress={() => void save(parrotEditorLinesText(lines))}
                />
              </View>
              <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
                {t("shell.lyricsEditor.title", { title })}
              </Text>
              <Text style={styles.meta}>{t("shell.lyricsEditor.timingHint")}</Text>
              <View style={styles.toolbar}>
                <MobileButton
                  testID="lyrics-editor-play"
                  variant="secondary"
                  style={styles.inline}
                  label={playing ? t("shell.lyricsEditor.pause") : t("shell.lyricsEditor.play")}
                  onPress={() => void (playing ? AudioPlayback.pause() : AudioPlayback.play())}
                />
                <MobileButton testID="lyrics-editor-tap" style={styles.inline} label={t("shell.lyricsEditor.tap")} onPress={() => void tap()} />
                <MobileIconButton
                  testID="lyrics-editor-earlier"
                  label={t("shell.lyricsEditor.earlier")}
                  disabled={currentMs === null}
                  onPress={() => setLines(nudgeParrotEditorLine(lines, current, -NUDGE_MS))}
                >
                  <Minus size={24} color={colors.text} />
                </MobileIconButton>
                <MobileIconButton
                  testID="lyrics-editor-later"
                  label={t("shell.lyricsEditor.later")}
                  disabled={currentMs === null}
                  onPress={() => setLines(nudgeParrotEditorLine(lines, current, NUDGE_MS))}
                >
                  <Plus size={24} color={colors.text} />
                </MobileIconButton>
                <MobileButton
                  testID="lyrics-editor-replay"
                  variant="ghost"
                  style={styles.inline}
                  label={t("shell.lyricsEditor.replay")}
                  disabled={currentMs === null}
                  onPress={() => {
                    if (currentMs === null) return;
                    void AudioPlayback.seekTo(currentMs).then(() => (playing ? undefined : AudioPlayback.play()));
                  }}
                />
                <MobileButton
                  testID="lyrics-editor-clear"
                  variant="ghost"
                  style={styles.inline}
                  label={t("shell.lyricsEditor.clearTimes")}
                  onPress={() => setLines(clearParrotEditorTimes(lines))}
                />
              </View>
              <Text style={styles.meta} testID="lyrics-editor-count">
                {t("shell.lyricsEditor.timedCount", { timed, total: lines.length })}
              </Text>
              {problemLine}
              <ScrollView style={styles.lines}>
                {lines.map((line, index) => (
                  <Pressable
                    key={index}
                    testID="lyrics-editor-line"
                    accessibilityRole="button"
                    accessibilityState={{ selected: index === current }}
                    onPress={() => setCurrent(index)}
                    style={[styles.line, index === current && styles.lineCurrent]}
                  >
                    <Text style={styles.lineTime}>{line.ms === null ? "–" : lineTime(line.ms)}</Text>
                    <Text style={[styles.lineText, index === current && styles.lineTextCurrent]}>{line.text}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : (
            <View style={[styles.page, pageBottom]} testID="lyrics-editor">
              <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
                {t("shell.lyricsEditor.title", { title })}
              </Text>
              <Text style={styles.meta}>{t("shell.lyricsEditor.body")}</Text>
              {/* The box sizes the field: given flex itself, a multiline TextInput shrank to one line when the keyboard opened (op9, API 34). */}
              <View style={styles.inputBox}>
                <TextInput
                  testID="lyrics-editor-text"
                  multiline
                  value={text}
                  onChangeText={(next) => {
                    setText(next);
                    setProblem(null);
                  }}
                  placeholder={t("shell.lyricsEditor.placeholder")}
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel={t("shell.lyricsEditor.title", { title })}
                  textAlignVertical="top"
                  style={styles.input}
                />
              </View>
              {problemLine}
              <View style={styles.footer}>
                <MobileButton testID="lyrics-editor-cancel" variant="ghost" style={styles.inline} label={t("shell.lyricsEditor.cancel")} onPress={onClose} />
                <View style={styles.footerEnd}>
                  <MobileButton
                    testID="lyrics-editor-save-words"
                    variant="secondary"
                    style={styles.inline}
                    label={t("shell.lyricsEditor.saveWords")}
                    disabled={saving}
                    onPress={() => void save(text)}
                  />
                  <MobileButton
                    testID="lyrics-editor-time"
                    style={styles.inline}
                    label={t("shell.lyricsEditor.timeLyrics")}
                    disabled={parrotEditorLines(text).length === 0}
                    onPress={startTiming}
                  />
                </View>
              </View>
            </View>
          )}
        </KeyboardAvoidingForm>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.lg },
  page: { flex: 1, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  meta: { color: colors.textMuted, fontSize: 13 },
  inputBox: { flex: 1 },
  input: {
    color: colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.md,
    ...StyleSheet.absoluteFill,
  },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  lines: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  line: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, alignItems: "baseline" },
  lineCurrent: { backgroundColor: colors.border },
  lineTime: { color: colors.textMuted, fontSize: 12, fontVariant: ["tabular-nums"], width: 64 },
  lineText: { color: colors.text, opacity: 0.8, fontSize: 15, flex: 1 },
  lineTextCurrent: { opacity: 1, fontWeight: "700" },
  problem: { color: colors.danger, fontSize: 14 },
  footer: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  footerEnd: { flexDirection: "row", gap: spacing.sm },
  inline: { paddingHorizontal: spacing.lg },
});
