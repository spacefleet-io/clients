// Managing the library from the phone, as the desktop does: editing a song's or an album's details and an album's cover
// (PAR-META-16/17) and deleting a song, an album or an artist (PAR-LIB-03). The form, the changed marks and the edit it
// saves are the shared ones of @space/parrot-core; this provider only draws them, asks before a delete, saves through
// the session (a new encrypted library snapshot) and says how it went in a short notice. The form looks things up on
// its own (`useEditLookups`): "Look it up again" (PAR-META-18) and the song's or album's lyrics (PAR-LYR-05), with a
// shimmer while an answer is on its way, so loading never looks like "nothing found" (PAR-META-20).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ImagePlus, RotateCw, Search } from "lucide-react-native";
import { launchImageLibrary } from "react-native-image-picker";
import { Buffer } from "buffer";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileNoticeBanner } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import {
  parrotEditFieldChanged,
  parrotEditFields,
  parrotEditNumber,
  parrotEditTarget,
  type ParrotEditCover,
  type ParrotEditFields,
  type ParrotManageTarget,
} from "@space/parrot-core";
import { deleteFromLibrary, editDetails, getEditValues, previewDelete } from "../lib/library";
import { ParrotArt } from "../screens/art";
import { Shimmer } from "../screens/shimmer";
import { colors, spacing } from "../theme";
import { useEditLookups, type EditLookups } from "./editLookups";
import { useSession } from "./session";

/** A song or an album the form edits; `coverKey` shows an album's current cover beside the picker. */
export type EditableItem = { kind: "track" | "album"; id: string; title: string; coverKey?: string | null };

type Editing = { item: EditableItem; fields: ParrotEditFields };

export type Manage = {
  /** Opens the edit form with the item's current details. */
  edit: (item: EditableItem) => void;
  /** Counts what would go, asks, then deletes; `onDeleted` runs once the library is saved without it. */
  remove: (target: ParrotManageTarget, title: string, onDeleted?: () => void) => void;
  /** A short notice under the screens. */
  notify: (message: string, tone: "info" | "error") => void;
};

const ManageContext = createContext<Manage | null>(null);

export const useManage = () => {
  const value = useContext(ManageContext);
  if (!value) throw new Error("useManage outside ManageProvider");
  return value;
};

const NOTICE_MS = 4000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const ManageProvider = ({ children }: { children: React.ReactNode }) => {
  const { t, i18n } = useTranslation();
  const { changeLibrary } = useSession();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: "info" | "error" } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const notify = useCallback((message: string, tone: "info" | "error") => {
    clearTimeout(noticeTimer.current);
    setNotice({ message, tone });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const deleteBody = useCallback(
    (target: ParrotManageTarget, trackCount: number) =>
      target.kind === "track"
        ? t("shell.manage.deleteBody.track")
        : t(`shell.manage.deleteBody.${target.kind}.${new Intl.PluralRules(i18n.language).select(trackCount) === "one" ? "one" : "other"}`, { count: trackCount }),
    [t, i18n.language]
  );

  const value = useMemo<Manage>(
    () => ({
      edit: (item) => {
        void getEditValues(item).then(
          (values) => {
            if (!values) return notify(t("shell.manage.saveFailed", { reason: "not found" }), "error");
            setEditError(null);
            setEditing({ item, fields: parrotEditFields(values) });
          },
          (error: unknown) => notify(t("shell.manage.saveFailed", { reason: errorText(error) }), "error")
        );
      },
      remove: (target, title, onDeleted) => {
        void previewDelete(target).then(
          ({ trackCount }) =>
            Alert.alert(t("shell.manage.deleteTitle", { title }), deleteBody(target, trackCount), [
              { text: t("shell.manage.cancel"), style: "cancel" },
              {
                text: t("shell.manage.delete"),
                style: "destructive",
                onPress: () =>
                  void changeLibrary("delete", () => deleteFromLibrary(target)).then(
                    () => onDeleted?.(),
                    (error: unknown) => notify(t("shell.manage.deleteFailed", { reason: errorText(error) }), "error")
                  ),
              },
            ]),
          (error: unknown) => notify(t("shell.manage.deleteFailed", { reason: errorText(error) }), "error")
        );
      },
      notify,
    }),
    [changeLibrary, deleteBody, notify, t]
  );

  const save = async (fields: ParrotEditFields, cover: ParrotEditCover | null) => {
    if (!editing) return;
    const { item } = editing;
    setBusy(true);
    setEditError(null);
    try {
      await changeLibrary("edit", () => editDetails(parrotEditTarget(item, fields), item.kind === "album" ? cover : null));
      setEditing(null);
    } catch (error) {
      setEditError(t("shell.manage.saveFailed", { reason: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ManageContext.Provider value={value}>
      {children}
      {notice ? (
        <View pointerEvents="none" style={styles.noticeWrap} testID="manage-notice">
          <MobileNoticeBanner message={notice.message} tone={notice.tone} />
        </View>
      ) : null}
      <EditDetailsDialog editing={editing} busy={busy} error={editError} onClose={() => !busy && setEditing(null)} onSubmit={(fields, cover) => void save(fields, cover)} />
    </ManageContext.Provider>
  );
};

const coverPreview = (cover: ParrotEditCover | null) => {
  if (!cover) return null;
  if (cover.kind === "url") return cover.url;
  return `data:${cover.mime};base64,${Buffer.from(cover.bytes).toString("base64")}`;
};

/** The phone's edit form: the desktop dialog's fields and marks, one under the other; an album's cover from the gallery. */
export const EditDetailsDialog = ({
  editing,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  editing: Editing | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (fields: ParrotEditFields, cover: ParrotEditCover | null) => void;
}) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [album, setAlbum] = useState("");
  const [number, setNumber] = useState("");
  const [disc, setDisc] = useState("1");
  const [year, setYear] = useState("");
  const [genre, setGenre] = useState("");
  const [cover, setCover] = useState<ParrotEditCover | null>(null);
  // The library's values a lookup was marked against: the fields that differ show "changed" (PAR-META-18).
  const [current, setCurrent] = useState<ParrotEditFields | undefined>(undefined);
  const libraryVersion = useSession().library.version;

  const fill = (values: ParrotEditFields) => {
    setTitle(values.title);
    setArtist(values.artist);
    setAlbum(values.album ?? "");
    setNumber(values.number ? String(values.number) : "");
    setDisc(String(values.disc ?? 1));
    setYear(values.year ? String(values.year) : "");
    setGenre(values.genre ?? "");
  };
  useEffect(() => {
    if (!editing) return;
    fill(editing.fields);
    setCover(null);
    setCurrent(undefined);
  }, [editing]);

  const lookups = useEditLookups({
    item: editing?.item ?? null,
    libraryVersion,
    // What was found fills the form, marked against the library's values; nothing is saved until Save.
    onFound: (answer) => {
      fill(parrotEditFields(answer.found));
      setCurrent(parrotEditFields(answer.current));
      if (answer.cover) setCover(answer.cover);
    },
  });

  const kind = editing?.item.kind ?? "track";
  const fields = (): ParrotEditFields => ({
    title: title.trim(),
    artist: artist.trim(),
    ...(kind === "track" ? { album: album.trim(), number: parrotEditNumber(number), disc: parrotEditNumber(disc) ?? 1 } : {}),
    year: parrotEditNumber(year),
    genre: genre.trim() || null,
  });
  const canSave = title.trim().length > 0 && !busy;

  const pickCover = async () => {
    const picked = await launchImageLibrary({ mediaType: "photo", includeBase64: true, selectionLimit: 1 });
    const asset = picked.assets?.[0];
    if (!asset?.base64) return;
    setCover({ kind: "file", bytes: new Uint8Array(Buffer.from(asset.base64, "base64")), mime: asset.type ?? "image/jpeg" });
  };

  const field = (key: keyof ParrotEditFields, label: string, value: string, set: (v: string) => void, numeric = false) => (
    <View style={styles.field} key={key}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {parrotEditFieldChanged(fields(), current, key) ? (
          <Text style={styles.changed} testID={`manage-changed-${key}`}>
            {t("shell.manage.changed")}
          </Text>
        ) : null}
      </View>
      <TextInput
        testID={`manage-field-${key}`}
        value={value}
        onChangeText={set}
        keyboardType={numeric ? "number-pad" : "default"}
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
    </View>
  );

  const preview = coverPreview(cover);
  return (
    <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={onClose}>
      {/* UX-CRASH-01: a crash inside the form closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:manage-edit" onDismiss={onClose}>
        <KeyboardAvoidingView behavior="padding" style={styles.scrim}>
          <View style={styles.dialog} testID="manage-edit-dialog">
            <ScrollView contentContainerStyle={{ gap: spacing.md }} keyboardShouldPersistTaps="handled">
              <Text style={styles.title}>{t(`shell.manage.editTitle.${kind}`)}</Text>
              {lookups && editing ? <LookUpRow lookUp={lookups.lookUp} title={editing.item.title} /> : null}
              {field("title", t("shell.manage.field.title"), title, setTitle)}
              {field("artist", kind === "album" ? t("shell.manage.field.albumArtist") : t("shell.manage.field.artist"), artist, setArtist)}
              {kind === "track" ? field("album", t("shell.manage.field.album"), album, setAlbum) : null}
              <View style={styles.row}>
                {kind === "track" ? field("number", t("shell.manage.field.number"), number, setNumber, true) : null}
                {kind === "track" ? field("disc", t("shell.manage.field.disc"), disc, setDisc, true) : null}
                {field("year", t("shell.manage.field.year"), year, setYear, true)}
              </View>
              {field("genre", t("shell.manage.field.genre"), genre, setGenre)}
              {kind === "album" ? (
                <Pressable testID="manage-cover-pick" accessibilityRole="button" accessibilityLabel={t("shell.manage.coverPick")} onPress={() => void pickCover()} style={styles.cover}>
                  {preview ? (
                    <Image source={{ uri: preview }} style={styles.coverImage} testID="manage-cover-preview" />
                  ) : (
                    <ParrotArt seed={editing?.item.id ?? ""} size={64} radius={8} coverKey={editing?.item.coverKey ?? null} />
                  )}
                  <View style={{ flex: 1, gap: spacing.xs }}>
                    <View style={styles.labelRow}>
                      <Text style={styles.label}>{t("shell.manage.field.cover")}</Text>
                      {cover ? <Text style={styles.changed}>{t("shell.manage.changed")}</Text> : null}
                    </View>
                    <View style={styles.labelRow}>
                      <ImagePlus size={18} color={colors.accent} />
                      <Text style={styles.pick}>{t("shell.manage.coverPick")}</Text>
                    </View>
                  </View>
                </Pressable>
              ) : null}
              {lookups ? <LyricsSection lyrics={lookups.lyrics} /> : null}
              {error ? (
                <Text style={styles.error} accessibilityRole="alert" testID="manage-edit-error">
                  {error}
                </Text>
              ) : null}
              <View style={styles.buttons}>
                <Pressable testID="manage-edit-cancel" accessibilityRole="button" onPress={onClose} style={styles.button}>
                  <Text style={styles.cancelText}>{t("shell.manage.cancel")}</Text>
                </Pressable>
                <Pressable
                  testID="manage-edit-submit"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canSave, busy }}
                  disabled={!canSave}
                  onPress={() => onSubmit(fields(), cover)}
                  style={[styles.button, styles.submit, !canSave && { opacity: 0.4 }]}
                >
                  <Text style={styles.submitText}>{t("shell.manage.save")}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </MobileRenderBoundary>
    </Modal>
  );
};

/** "Look it up again" (PAR-META-18): asks for a better match and fills the form with it; nothing is saved until Save. */
const LookUpRow = ({ lookUp, title }: { lookUp: EditLookups["lookUp"]; title: string }) => {
  const { t } = useTranslation();
  const busy = lookUp.state === "busy";
  const note = busy
    ? t("shell.manage.searching")
    : lookUp.state === "found"
      ? t("shell.manage.lookUpFound")
      : lookUp.state === "none"
        ? t("shell.manage.fetchNone", { title })
        : lookUp.state === "failed"
          ? t("shell.manage.fetchFailed", { reason: lookUp.reason ?? "" })
          : t("shell.manage.lookUpHint");
  return (
    <View style={styles.lookUp} testID="manage-look-up" accessibilityState={{ busy }}>
      <Text
        style={[styles.body, { flex: 1 }, lookUp.state === "failed" && { color: colors.danger }]}
        accessibilityRole={lookUp.state === "failed" ? "alert" : undefined}
        testID="manage-look-up-note"
      >
        {note}
      </Text>
      <Pressable
        testID="manage-look-up-button"
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={lookUp.run}
        style={[styles.lookUpButton, busy && { opacity: 0.4 }]}
      >
        <Search size={16} color={colors.accent} />
        <Text style={styles.pick}>{t("shell.manage.lookUp")}</Text>
      </Pressable>
    </View>
  );
};

/**
 * The Lyrics section (PAR-LYR-05, PAR-META-20): a shimmer while the words are read or looked up, then the first lines,
 * or "No lyrics found" / the failure with "Search again"; an album says how many of its songs have words.
 */
const LyricsSection = ({ lyrics }: { lyrics: EditLookups["lyrics"] }) => {
  const { t } = useTranslation();
  const state = lyrics.state;
  const again = (label: string, onPress: () => void) => (
    <Pressable testID="manage-lyrics-search" accessibilityRole="button" onPress={onPress} style={styles.again}>
      <RotateCw size={16} color={colors.accent} />
      <Text style={styles.pick}>{label}</Text>
    </Pressable>
  );
  let body: React.ReactNode = null;
  if (state.status === "loading")
    body = (
      <View style={{ gap: spacing.sm }} accessibilityState={{ busy: true }} testID="manage-lyrics-loading">
        <Text style={styles.label}>{t("shell.nowPlaying.searchingLyricsTitle")}</Text>
        <Shimmer style={[styles.shimmerLine, { width: "75%" }]} />
        <Shimmer style={[styles.shimmerLine, { width: "50%" }]} />
      </View>
    );
  else if (state.status === "found")
    body = (
      <View style={{ gap: 2 }} testID="manage-lyrics-found">
        {state.preview.map((line, index) => (
          <Text key={index} style={styles.lyricLine} numberOfLines={1}>
            {line}
          </Text>
        ))}
      </View>
    );
  else if (state.status === "counted" && lyrics.kind === "album")
    body = (
      <View style={{ gap: spacing.xs }} testID="manage-lyrics-counted">
        <Text style={styles.lyricLine}>{t("shell.manage.albumLyrics", { found: state.found, count: state.count })}</Text>
        {state.missing > 0 ? again(t("shell.manage.albumLyricsSearch"), lyrics.searchMissing) : null}
      </View>
    );
  else if ((state.status === "none" || state.status === "failed") && lyrics.kind === "track")
    body = (
      <View style={{ gap: spacing.xs }} testID={state.status === "failed" ? "manage-lyrics-failed" : "manage-lyrics-none"}>
        <Text style={state.status === "failed" ? styles.error : styles.body} accessibilityRole={state.status === "failed" ? "alert" : undefined}>
          {state.status === "failed" ? t("shell.manage.lyricsFailed", { reason: state.reason }) : t("shell.nowPlaying.noLyricsFoundBody")}
        </Text>
        {again(t("shell.manage.lyricsSearchAgain"), lyrics.searchAgain)}
      </View>
    );
  return (
    <View style={styles.lyrics} testID="manage-lyrics">
      <Text style={styles.label}>{t("shell.manage.lyrics")}</Text>
      {body}
    </View>
  );
};

const styles = StyleSheet.create({
  noticeWrap: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: 140 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing.lg },
  dialog: { backgroundColor: colors.surfaceRaised, borderRadius: 16, padding: spacing.xl, maxHeight: "90%" },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  body: { color: colors.textMuted, fontSize: 14 },
  field: { flex: 1, gap: spacing.xs },
  row: { flexDirection: "row", gap: spacing.md },
  labelRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { color: colors.textMuted, fontSize: 13 },
  changed: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  input: { color: colors.text, fontSize: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: spacing.md, minHeight: 48 },
  cover: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, borderRadius: 12, padding: spacing.md },
  coverImage: { width: 64, height: 64, borderRadius: 8 },
  pick: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 14 },
  lookUp: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderRadius: 12, padding: spacing.md, backgroundColor: colors.surface },
  lookUpButton: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 22, borderWidth: 1, borderColor: colors.border },
  lyrics: { gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: spacing.md },
  lyricLine: { color: colors.text, fontSize: 14 },
  shimmerLine: { height: 12, borderRadius: 4 },
  again: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 44 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  button: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  submit: { backgroundColor: colors.accent },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: "700" },
  submitText: { color: colors.accentText, fontSize: 15, fontWeight: "800" },
});
