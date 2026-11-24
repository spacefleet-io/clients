// Managing the library from the phone, as the desktop does: editing a song's or an album's details and an album's cover
// (PAR-META-16/17) and deleting a song, an album or an artist (PAR-LIB-03). The form, the changed marks and the edit it
// saves are the shared ones of @space/parrot-core; this provider only draws them, asks before a delete, saves through
// the session (a new encrypted library snapshot) and says how it went in a short notice. The form looks things up on
// its own (`useEditLookups`): the fields that name something suggest as the user types, connected to every other field
// (PAR-META-18), and the song's or album's lyrics (PAR-LYR-05), with a shimmer while an answer is on its way, so
// loading never looks like "nothing found" (PAR-META-20).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";
import { ImagePlus, RotateCcw, RotateCw } from "lucide-react-native";
import { launchImageLibrary } from "react-native-image-picker";
import { Buffer } from "buffer";
import { KeyboardAvoidingForm } from "@space/mobile-shell/keyboard";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileNoticeBanner, MobileSkeletonPulse } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import {
  applyParrotEditSuggestion,
  parrotEditFieldChanged,
  parrotEditFields,
  parrotEditNumber,
  parrotEditTarget,
  type ParrotEditCover,
  type ParrotEditFields,
  type ParrotEditSuggestion,
  type ParrotEditSuggestQuery,
  type ParrotManageTarget,
} from "@space/parrot-core";
import { shellPluralForm } from "@space/parrot-core/shell-strings";
import { deleteFromLibrary, editDetails, getEditValues, previewDelete } from "../lib/library";
import { ParrotArt } from "../screens/art";
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
        : t(`shell.manage.deleteBody.${target.kind}.${shellPluralForm(i18n.language, trackCount)}`, { count: trackCount }),
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
        // A throw while asking (not only a failed preview) says why rather than leaving the tap without an answer.
        void previewDelete(target)
          .then(({ trackCount }) =>
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
            ])
          )
          .catch((error: unknown) => notify(t("shell.manage.deleteFailed", { reason: errorText(error) }), "error"));
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

type SuggestField = ParrotEditSuggestQuery["field"];
/** What a pick replaced, so Undo puts the whole form back as it was just before (an earlier pick included). */
type Filled = { name: string; before: { fields: ParrotEditFields; cover: ParrotEditCover | null; current: ParrotEditFields | undefined; filled: Filled | null } };

/** A field's value as the form shows it (the struck-through old value beside "changed"). */
const shownValue = (value: ParrotEditFields[keyof ParrotEditFields]) => (value === null || value === undefined ? "" : String(value));

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
  // The library's values a pick is marked against: the fields it changed show "changed", the old value and ↺ (PAR-META-18).
  const [current, setCurrent] = useState<ParrotEditFields | undefined>(undefined);
  const [filled, setFilled] = useState<Filled | null>(null);
  // The field whose suggestions show (the one being typed in).
  const [typing, setTyping] = useState<SuggestField | null>(null);
  const coverAsked = useRef(0);
  const scroll = useRef<ScrollViewInstance | null>(null);
  const fieldTops = useRef<Partial<Record<SuggestField, number>>>({});
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
    setFilled(null);
    setTyping(null);
    coverAsked.current += 1;
  }, [editing]);

  const lookups = useEditLookups({ item: editing?.item ?? null, original: editing ? { kind: editing.item.kind, values: editing.fields } : null, libraryVersion });

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

  const closeSuggestions = () => {
    setTyping(null);
    lookups?.suggest.ask(null);
  };

  /** Typing in a field that names something asks what fits it and every other field, and shows the list under it. */
  const typeIn = (key: SuggestField, set: (value: string) => void) => (text: string) => {
    set(text);
    if (typing !== key) scroll.current?.scrollTo({ y: Math.max(0, (fieldTops.current[key] ?? 0) - spacing.md), animated: true });
    setTyping(key);
    const others = { title, artist, album, [key]: text };
    lookups?.suggest.ask({ kind, field: key, text, fields: { title: others.title, artist: others.artist, ...(kind === "track" ? { album: others.album } : {}) } });
  };

  /** A pick fills every field it knows, marked against the library's values; nothing is saved until Save. */
  const pick = (suggestion: ParrotEditSuggestion, name: string) => {
    if (!editing || !lookups) return;
    const before = { fields: fields(), cover, current, filled };
    fill(applyParrotEditSuggestion(kind, before.fields, suggestion));
    setCurrent(editing.fields);
    setFilled({ name, before });
    closeSuggestions();
    const ask = (coverAsked.current += 1);
    const sameAlbum = suggestion.inLibrary && suggestion.album?.id === editing.item.id;
    if (kind !== "album" || !suggestion.coverId || sameAlbum) return;
    lookups.suggest.cover(suggestion).then(
      (found) => {
        if (found && coverAsked.current === ask) setCover(found);
      },
      (failure: unknown) => console.warn(`[parrot] edit dialog could not fetch the picked album's cover: ${errorText(failure)}`)
    );
  };

  const undo = () => {
    if (!filled) return;
    coverAsked.current += 1;
    fill(filled.before.fields);
    setCover(filled.before.cover);
    setCurrent(filled.before.current);
    setFilled(filled.before.filled);
  };

  const setters: Record<keyof ParrotEditFields, (value: string) => void> = {
    title: setTitle,
    artist: setArtist,
    album: setAlbum,
    number: setNumber,
    disc: setDisc,
    year: setYear,
    genre: setGenre,
  };

  const field = (key: keyof ParrotEditFields, label: string, value: string, set: (v: string) => void, numeric = false) => {
    const suggests = key === "title" || key === "artist" || key === "album";
    const was = current && parrotEditFieldChanged(fields(), current, key) ? shownValue(current[key]) : null;
    const list = suggests && typing === key && lookups?.suggest.list?.field === key ? lookups.suggest.list : null;
    return (
      <View
        style={styles.field}
        key={key}
        onLayout={suggests ? (event) => (fieldTops.current[key as SuggestField] = event.nativeEvent.layout.y) : undefined}
      >
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          {was !== null ? (
            <>
              <Text style={styles.changed} testID={`manage-changed-${key}`}>
                {t("shell.manage.changed")}
              </Text>
              <Text style={styles.was} numberOfLines={1} testID={`manage-was-${key}`}>
                {was}
              </Text>
              <Pressable
                testID={`manage-restore-${key}`}
                accessibilityRole="button"
                accessibilityLabel={t("shell.manage.suggestRestore", { value: was })}
                hitSlop={12}
                onPress={() => setters[key](was === "" && key === "disc" ? "1" : was)}
              >
                <RotateCcw size={14} color={colors.accent} />
              </Pressable>
            </>
          ) : null}
        </View>
        <TextInput
          testID={`manage-field-${key}`}
          value={value}
          onChangeText={suggests ? typeIn(key as SuggestField, set) : set}
          onFocus={() => typing !== null && typing !== key && closeSuggestions()}
          keyboardType={numeric ? "number-pad" : "default"}
          autoCorrect={suggests ? false : undefined}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />
        {list ? <SuggestList list={list} kind={kind} onPick={pick} /> : null}
      </View>
    );
  };

  const preview = coverPreview(cover);
  return (
    <Modal visible={editing !== null} transparent animationType="fade" onRequestClose={onClose}>
      {/* UX-CRASH-01: a crash inside the form closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:manage-edit" onDismiss={onClose}>
        <KeyboardAvoidingForm style={styles.scrim}>
          <View style={styles.dialog} testID="manage-edit-dialog">
            <ScrollView ref={scroll} contentContainerStyle={{ gap: spacing.md }} keyboardShouldPersistTaps="handled">
              <Text style={styles.title}>{t(`shell.manage.editTitle.${kind}`)}</Text>
              {filled ? (
                <View style={styles.filled} testID="manage-suggest-filled">
                  <Text style={[styles.body, { flex: 1 }]} testID="manage-suggest-filled-note">
                    {t("shell.manage.suggestFilledFrom", { name: filled.name })}
                  </Text>
                  <Pressable testID="manage-suggest-undo" accessibilityRole="button" onPress={undo} style={styles.undo}>
                    <Text style={styles.pick}>{t("shell.manage.suggestUndo")}</Text>
                  </Pressable>
                </View>
              ) : null}
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
                <View style={styles.coverRow}>
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
                  {cover ? (
                    <Pressable
                      testID="manage-restore-cover"
                      accessibilityRole="button"
                      accessibilityLabel={t("shell.manage.suggestRestore", { value: t("shell.manage.field.cover") })}
                      hitSlop={12}
                      onPress={() => {
                        coverAsked.current += 1;
                        setCover(null);
                      }}
                      style={styles.restoreCover}
                    >
                      <RotateCcw size={18} color={colors.accent} />
                    </Pressable>
                  ) : null}
                </View>
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
        </KeyboardAvoidingForm>
      </MobileRenderBoundary>
    </Modal>
  );
};

/** How many results each section shows: the list stays short enough to sit under the field above the keyboard. */
const SUGGEST_SECTION_MAX = 5;

/**
 * The list under the field being typed in (PAR-META-18): "Fits this song" (results that fit the other fields too), then
 * "Only “…”" (the typed text alone); the library's first in each, tagged, with dots for the fields each fits. While our
 * music library is still being asked a shimmer row says so (PAR-META-20); a failed ask says why in one line.
 */
const SuggestList = ({
  list,
  kind,
  onPick,
}: {
  list: NonNullable<EditLookups["suggest"]["list"]>;
  kind: "track" | "album";
  onPick: (suggestion: ParrotEditSuggestion, name: string) => void;
}) => {
  const { t } = useTranslation();
  // In music terms: an album dialog's title is the album's title.
  const music = kind === "album" && list.field === "title" ? "album" : list.field;
  const dots: Array<{ fit: "title" | "artist" | "album"; label: string }> =
    kind === "track"
      ? [
          { fit: "title", label: t("shell.manage.field.title") },
          { fit: "artist", label: t("shell.manage.field.artist") },
          { fit: "album", label: t("shell.manage.field.album") },
        ]
      : [
          { fit: "artist", label: t("shell.manage.field.albumArtist") },
          { fit: "album", label: t("shell.manage.field.title") },
        ];
  const row = (suggestion: ParrotEditSuggestion) => {
    const named = { title: suggestion.song?.title, artist: suggestion.artist.name, album: suggestion.album?.title }[music];
    const name = named ?? suggestion.song?.title ?? suggestion.album?.title ?? suggestion.artist.name;
    const track = suggestion.kind === "song" && music !== "title" && suggestion.song && suggestion.album?.trackNumber != null ? suggestion.album.trackNumber : null;
    const about = [
      music !== "artist" ? suggestion.artist.name : null,
      music !== "album" ? suggestion.album?.title : null,
      suggestion.album?.year,
      track !== null ? t("shell.manage.suggestTrackOn", { title: suggestion.song?.title ?? "", number: track }) : null,
    ]
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join(" · ");
    const fits = dots.filter((dot) => suggestion.fits[dot.fit]).map((dot) => dot.label);
    return (
      <Pressable
        key={suggestion.key}
        testID="manage-suggest-row"
        accessibilityRole="button"
        accessibilityLabel={[name, about, suggestion.inLibrary ? t("shell.manage.suggestInLibrary") : null].filter(Boolean).join(", ")}
        onPress={() => onPick(suggestion, name)}
        style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.surface }]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.labelRow}>
            <Text style={styles.suggestName} numberOfLines={1}>
              {name}
            </Text>
            {suggestion.inLibrary ? (
              <Text style={styles.tag} testID="manage-suggest-in-library">
                {t("shell.manage.suggestInLibrary")}
              </Text>
            ) : null}
          </View>
          {about ? (
            <Text style={styles.suggestAbout} numberOfLines={1}>
              {about}
            </Text>
          ) : null}
        </View>
        <View style={styles.dots} testID="manage-suggest-dots" accessibilityLabel={t("shell.manage.suggestDots", { fields: fits.join(", ") })}>
          {dots.map((dot) => (
            <View key={dot.fit} style={[styles.dot, suggestion.fits[dot.fit] && styles.dotOn]} />
          ))}
        </View>
      </Pressable>
    );
  };
  const fitting = list.suggestions.all.slice(0, SUGGEST_SECTION_MAX);
  const only = list.suggestions.field.slice(0, SUGGEST_SECTION_MAX);
  const asking = list.lookup.status === "busy";
  const failed = list.lookup.status === "failed" ? list.lookup.reason : null;
  if (fitting.length === 0 && only.length === 0 && !asking && failed === null) return null;
  return (
    <View style={styles.suggest} testID="manage-suggest" accessibilityState={{ busy: asking }}>
      {fitting.length > 0 ? (
        <View testID="manage-suggest-fits">
          <Text style={styles.section}>{t(kind === "album" ? "shell.manage.suggestFitsAlbum" : "shell.manage.suggestFits")}</Text>
          {fitting.map(row)}
        </View>
      ) : null}
      {only.length > 0 ? (
        <View testID="manage-suggest-only">
          <Text style={styles.section}>{t("shell.manage.suggestOnly", { text: list.text.trim() })}</Text>
          {only.map(row)}
        </View>
      ) : null}
      {asking ? (
        <View style={styles.asking} testID="manage-suggest-asking">
          <MobileSkeletonPulse style={[styles.shimmerLine, { flex: 1 }]} />
          <Text style={styles.suggestAbout}>{t("shell.manage.suggestStillAsking")}</Text>
        </View>
      ) : null}
      {failed !== null ? (
        <Text style={[styles.suggestAbout, { color: colors.danger }]} accessibilityRole="alert" testID="manage-suggest-failed" numberOfLines={1}>
          {t("shell.manage.fetchFailed", { reason: failed })}
        </Text>
      ) : null}
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
        <MobileSkeletonPulse style={[styles.shimmerLine, { width: "75%" }]} />
        <MobileSkeletonPulse style={[styles.shimmerLine, { width: "50%" }]} />
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
  was: { flexShrink: 1, color: colors.textMuted, fontSize: 12, textDecorationLine: "line-through" },
  input: { color: colors.text, fontSize: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: spacing.md, minHeight: 48 },
  coverRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cover: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, borderRadius: 12, padding: spacing.md },
  restoreCover: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  coverImage: { width: 64, height: 64, borderRadius: 8 },
  pick: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 14 },
  filled: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderRadius: 12, padding: spacing.md, backgroundColor: colors.surface },
  undo: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 22, borderWidth: 1, borderColor: colors.border, justifyContent: "center" },
  suggest: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: spacing.xs, backgroundColor: colors.bg },
  section: { color: colors.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  suggestRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  suggestName: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  suggestAbout: { color: colors.textMuted, fontSize: 12 },
  tag: { color: colors.accent, fontSize: 11, fontWeight: "700", borderWidth: 1, borderColor: colors.accent, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  dots: { flexDirection: "row", gap: 4 },
  dot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1, borderColor: colors.textMuted },
  dotOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  asking: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 40, paddingHorizontal: spacing.md },
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
