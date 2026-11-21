// Editing playlists and the heart on the phone (PAR-PL-02, PAR-PL-04): one place that holds the song sheet (heart, go to
// the album and the artist where the caller can, add to playlist, remove from this playlist, save offline, edit
// metadata and delete through ./manage), the actions sheet of a page's "…", the playlist picker, the name dialog and
// the delete confirm, saves each change through the session (a new encrypted library snapshot, PAR-PL-03) and says how
// it went in a short notice. Every sheet is the phone's one bottom sheet (UX-SHEET-01): a tap outside, Back or a drag
// down closes it. A change that could not be saved never shows: the heart goes back and the lists keep the server's
// library. Keeping an album, a playlist or a song (PAR-OFFL-01) asks first which copy to keep when the songs have more
// than one besides the light copy (PAR-OFFL-02).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowDownToLine, CircleCheck, Disc3, FileAudio, Heart, HeartOff, ListMusic, ListPlus, ListX, MicVocal, Pencil, Plus, Trash2, X } from "lucide-react-native";
import crypto from "react-native-quick-crypto";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileBottomSheet, MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { MobileNoticeBanner } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { formatLocalizedStorage } from "@space/shared/format";
import {
  areAllLiked,
  cleanPlaylistName,
  isLikedSong,
  newPlaylistEdit,
  PARROT_PLAYLIST_NAME_MAX,
  toggleLikeAllEdits,
  type KeepCopyChoice,
  type KeptKind,
  type ParrotPlaylist,
  type ParrotPlaylistEdit,
} from "@space/parrot-core";
import { listPlaylists } from "../lib/library";
import { keepChoices, keepItem, unkeepItem } from "../lib/kept";
import { isLikedPlaylist } from "../lib/playlists";
import { useKept, type KeptView } from "../screens/kept";
import { colors, spacing } from "../theme";
import { useSession } from "./session";
import { useQuery } from "./useQuery";
import { useManage } from "./manage";

/** A song, or an album standing for its songs (`trackIds`) when it is added to a playlist whole; `artist` shows under the song sheet's title. */
export type EditableSong = { id: string; title: string; artist?: string; trackIds?: string[] };
/** One row of an actions sheet (the album page's "…", PAR-LOOK-05); `destructive` draws it in the danger colour (Delete). */
export type SheetAction = {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  onSelect: () => void;
  testID: string;
  destructive?: boolean;
};
/** The song sheet's way to the song's album and artist pages (the player's "…", PAR-NAV-05); left out where unknown. */
export type SongLinks = { onGoToAlbum?: () => void; onGoToArtist?: () => void };
/** Where a song row sits when it is a playlist's: removing it takes out that one entry. */
export type SongPlace = { playlistId: string; position: number };

type Dialog =
  | { kind: "song"; song: EditableSong; place?: SongPlace; links?: SongLinks }
  | { kind: "picker"; song: EditableSong }
  | { kind: "new"; song?: EditableSong; onCreated?: (id: string, name: string) => void }
  | { kind: "rename"; playlist: Pick<ParrotPlaylist, "id" | "name"> }
  | { kind: "keep"; item: { kind: KeptKind; id: string }; choices: KeepCopyChoice[] }
  | { kind: "actions"; title: string; actions: SheetAction[]; testID: string };

type Notice = { message: string; tone: "info" | "error" };

export type PlaylistEditor = {
  /** The library's playlists, "Liked songs" first (shown even before the library has it). */
  playlists: ParrotPlaylist[];
  /** Whether the heart is on for this song, counting a like that is being saved. */
  liked: (trackId: string) => boolean;
  toggleLike: (trackId: string) => void;
  /** Every one of these songs is liked (an album's heart is on, PAR-PL-04). */
  allLiked: (trackIds: readonly string[]) => boolean;
  /** An album's heart: likes the songs not liked yet, or unlikes them all when every one is liked already. */
  toggleLikeAll: (trackIds: readonly string[]) => void;
  /** A sheet of actions under a title; picking one closes it and runs it. */
  openActions: (title: string, actions: SheetAction[], testID: string) => void;
  /** The song sheet: heart, go to album and artist (with `links`), add to playlist, remove when the row is a playlist's, keep, edit, delete. */
  openSong: (song: EditableSong, place?: SongPlace, links?: SongLinks) => void;
  newPlaylist: (onCreated?: (id: string, name: string) => void) => void;
  /** The playlist picker straight away (an album added whole). */
  addToPlaylist: (song: EditableSong) => void;
  renamePlaylist: (playlist: Pick<ParrotPlaylist, "id" | "name">) => void;
  /** Asks first; on yes `onDeleted` runs at once (the page closes) and the deletion is saved. */
  deletePlaylist: (playlist: Pick<ParrotPlaylist, "id" | "name">, onDeleted?: () => void) => void;
  /** Keeps an album, a playlist or a song on this phone (asking which copy when there is a real choice), or removes it. */
  toggleKeep: (kind: KeptKind, id: string) => void;
};

const EditorContext = createContext<PlaylistEditor | null>(null);

export const usePlaylistEditor = () => {
  const value = useContext(EditorContext);
  if (!value) throw new Error("usePlaylistEditor outside PlaylistEditorProvider");
  return value;
};

const NOTICE_MS = 4000;

export const PlaylistEditorProvider = ({ children }: { children: React.ReactNode }) => {
  const { t, i18n } = useTranslation();
  const { library, localChanges, saveEdits } = useSession();
  const manage = useManage();
  const version = library.status === "ready" ? library.version : -1;
  const loaded = useQuery(() => (library.status === "ready" ? listPlaylists() : Promise.resolve([])), [version, localChanges]);
  const playlists = useMemo(() => loaded.data ?? [], [loaded.data]);
  const [likes, setLikes] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A newly read library already holds every saved like.
  useEffect(() => setLikes(new Map()), [playlists]);
  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
  }, []);

  const show = useCallback((next: Notice) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  /** Saves `edits`; true once saved, false after the failure notice. */
  const save = useCallback(
    async (edits: ParrotPlaylistEdit[], done?: string) => {
      try {
        await saveEdits(edits);
        if (done) show({ message: done, tone: "info" });
        return true;
      } catch {
        show({ message: t("shell.playlists.saveFailed"), tone: "error" });
        return false;
      }
    },
    [saveEdits, show, t]
  );

  const nameOf = useCallback((playlist: Pick<ParrotPlaylist, "id" | "name">) => (isLikedPlaylist(playlist.id) ? t("shell.playlists.liked") : playlist.name), [t]);
  const liked = useCallback((trackId: string) => likes.get(trackId) ?? isLikedSong(playlists, trackId), [likes, playlists]);

  const setLiked = useCallback(
    (trackIds: readonly string[], next: boolean) => {
      if (trackIds.length === 0) return;
      setLikes((current) => {
        const updated = new Map(current);
        for (const trackId of trackIds) updated.set(trackId, next);
        return updated;
      });
      void save(trackIds.map((trackId) => ({ kind: "like", trackId, liked: next }))).then((saved) => {
        if (!saved)
          setLikes((current) => {
            const without = new Map(current);
            for (const trackId of trackIds) without.delete(trackId);
            return without;
          });
      });
    },
    [save]
  );
  const setLike = useCallback((trackId: string, next: boolean) => setLiked([trackId], next), [setLiked]);
  const allLiked = useCallback((trackIds: readonly string[]) => areAllLiked(playlists, trackIds, liked), [playlists, liked]);

  const kept = useKept();
  const keepFailed = useCallback(
    (error: unknown) => {
      console.warn("parrot.kept.failed", error instanceof Error ? error.message : String(error));
      show({ message: t("parrot.kept.failed"), tone: "error" });
    },
    [show, t]
  );
  const toggleKeep = useCallback(
    (kind: KeptKind, id: string) => {
      if (kept.entry(kind, id)) {
        void unkeepItem(kind, id).catch(keepFailed);
        return;
      }
      void keepChoices(kind, id)
        .then((choices) => (choices.length >= 2 ? setDialog({ kind: "keep", item: { kind, id }, choices }) : keepItem(kind, id, null)))
        .catch(keepFailed);
    },
    [kept, keepFailed]
  );

  const value = useMemo<PlaylistEditor>(
    () => ({
      playlists,
      liked,
      toggleLike: (trackId) => setLike(trackId, !liked(trackId)),
      allLiked,
      toggleLikeAll: (trackIds) => {
        const edits = toggleLikeAllEdits(playlists, trackIds, liked);
        if (edits[0]) setLiked(edits.map((edit) => edit.trackId), edits[0].liked);
      },
      openActions: (title, actions, testID) => setDialog({ kind: "actions", title, actions, testID }),
      openSong: (song, place, links) => setDialog({ kind: "song", song, place, links }),
      newPlaylist: (onCreated) => setDialog({ kind: "new", onCreated }),
      addToPlaylist: (song) => setDialog({ kind: "picker", song }),
      renamePlaylist: (playlist) => setDialog({ kind: "rename", playlist }),
      deletePlaylist: (playlist, onDeleted) =>
        Alert.alert(t("shell.playlists.deleteTitle", { name: playlist.name }), t("shell.playlists.deleteBody"), [
          { text: t("shell.playlists.cancel"), style: "cancel" },
          {
            text: t("shell.playlists.delete"),
            style: "destructive",
            // Gone at once (PAR-PL-03): the page closes while the deletion is saved; a failed save brings it back
            // in the lists with the notice.
            onPress: () => {
              onDeleted?.();
              void save([{ kind: "delete", id: playlist.id }]);
            },
          },
        ]),
      toggleKeep,
    }),
    [playlists, liked, setLike, setLiked, allLiked, save, t, toggleKeep]
  );

  const close = () => setDialog(null);
  const addTo = (playlist: ParrotPlaylist, song: EditableSong) => {
    close();
    const trackIds = song.trackIds ?? [song.id];
    // The heart's playlist is filled by the heart: a like, never a plain add (PAR-PL-04).
    if (isLikedPlaylist(playlist.id)) setLiked(trackIds.filter((trackId) => !liked(trackId)), true);
    else void save([{ kind: "add", id: playlist.id, trackIds }], t("shell.playlists.added", { name: nameOf(playlist) }));
  };

  return (
    <EditorContext.Provider value={value}>
      {children}
      {notice ? (
        <View pointerEvents="none" style={styles.noticeWrap} testID="playlist-notice">
          <MobileNoticeBanner message={notice.message} tone={notice.tone} />
        </View>
      ) : null}
      <Sheet visible={dialog?.kind === "song" || dialog?.kind === "picker"} onClose={close} testID={dialog?.kind === "picker" ? "playlist-picker" : "song-sheet"}>
        {dialog?.kind === "song" ? (
          <>
            <Text style={styles.sheetTitle} numberOfLines={2} testID="song-sheet-title">
              {dialog.song.title}
            </Text>
            {dialog.song.artist ? (
              <Text style={styles.detail} numberOfLines={1} testID="song-sheet-artist">
                {dialog.song.artist}
              </Text>
            ) : null}
            <SheetRow
              testID="song-like"
              icon={liked(dialog.song.id) ? HeartOff : Heart}
              label={liked(dialog.song.id) ? t("shell.playlists.unlike") : t("shell.playlists.like")}
              onPress={() => {
                close();
                setLike(dialog.song.id, !liked(dialog.song.id));
              }}
            />
            {dialog.links?.onGoToAlbum ? (
              <SheetRow
                testID="song-go-to-album"
                icon={Disc3}
                label={t("shell.card.goToAlbum")}
                onPress={() => {
                  const go = dialog.links!.onGoToAlbum!;
                  close();
                  go();
                }}
              />
            ) : null}
            {dialog.links?.onGoToArtist ? (
              <SheetRow
                testID="song-go-to-artist"
                icon={MicVocal}
                label={t("shell.card.goToArtist")}
                onPress={() => {
                  const go = dialog.links!.onGoToArtist!;
                  close();
                  go();
                }}
              />
            ) : null}
            <SheetRow testID="song-add-to" icon={ListPlus} label={t("shell.playlists.addTo")} onPress={() => setDialog({ kind: "picker", song: dialog.song })} />
            {dialog.place ? (
              <SheetRow
                testID="song-remove"
                icon={ListX}
                label={t("shell.playlists.remove")}
                onPress={() => {
                  const place = dialog.place!;
                  close();
                  void save([{ kind: "remove", id: place.playlistId, position: place.position, trackId: dialog.song.id }]);
                }}
              />
            ) : null}
            <SongKeepRow
              kept={kept}
              trackId={dialog.song.id}
              onPress={() => {
                close();
                if (kept.entry("song", dialog.song.id) || !kept.holdsSong(dialog.song.id)) toggleKeep("song", dialog.song.id);
              }}
            />
            <SheetRow
              testID="song-edit"
              icon={Pencil}
              label={t("shell.manage.edit")}
              onPress={() => {
                close();
                manage.edit({ kind: "track", id: dialog.song.id, title: dialog.song.title });
              }}
            />
            <SheetRow
              testID="song-delete"
              icon={Trash2}
              destructive
              label={t("shell.manage.delete")}
              onPress={() => {
                close();
                manage.remove({ kind: "track", id: dialog.song.id }, dialog.song.title);
              }}
            />
          </>
        ) : dialog?.kind === "picker" ? (
          <>
            <Text style={styles.sheetTitle} numberOfLines={2}>
              {t("shell.playlists.addSongTo", { title: dialog.song.title })}
            </Text>
            <MobileSheetScrollView style={{ maxHeight: 420 }}>
              <SheetRow testID="picker-new" icon={Plus} label={t("shell.playlists.new")} onPress={() => setDialog({ kind: "new", song: dialog.song })} />
              {playlists.map((playlist) => (
                <SheetRow
                  key={playlist.id}
                  testID={isLikedPlaylist(playlist.id) ? "picker-liked" : "picker-playlist"}
                  icon={isLikedPlaylist(playlist.id) ? Heart : ListMusic}
                  label={nameOf(playlist)}
                  detail={t("parrot.library.songs", { count: playlist.trackCount })}
                  onPress={() => addTo(playlist, dialog.song)}
                />
              ))}
            </MobileSheetScrollView>
          </>
        ) : null}
      </Sheet>
      <Sheet visible={dialog?.kind === "actions"} onClose={close} testID={dialog?.kind === "actions" ? dialog.testID : "actions-sheet"}>
        {dialog?.kind === "actions" ? (
          <>
            <Text style={styles.sheetTitle} numberOfLines={2}>
              {dialog.title}
            </Text>
            {dialog.actions.map((action) => (
              <SheetRow
                key={action.id}
                testID={action.testID}
                icon={action.icon}
                label={action.label}
                destructive={action.destructive}
                onPress={() => {
                  close();
                  action.onSelect();
                }}
              />
            ))}
          </>
        ) : null}
      </Sheet>
      <Sheet visible={dialog?.kind === "keep"} onClose={close} testID="keep-choice">
        {dialog?.kind === "keep" ? (
          <>
            <Text style={styles.sheetTitle}>{t("shell.kept.chooseTitle")}</Text>
            <Text style={styles.detail}>{t("parrot.kept.chooseBody")}</Text>
            {dialog.choices.map((choice) => (
              <SheetRow
                key={choice.key}
                testID="keep-choice-option"
                icon={FileAudio}
                label={choice.label}
                detail={t("shell.kept.choiceDetail", { songs: t("parrot.library.songs", { count: choice.songs }), size: formatLocalizedStorage(choice.bytes, i18n.language) })}
                onPress={() => {
                  close();
                  void keepItem(dialog.item.kind, dialog.item.id, choice.key).catch(keepFailed);
                }}
              />
            ))}
            <SheetRow testID="keep-choice-cancel" icon={X} label={t("shell.kept.cancel")} onPress={close} />
          </>
        ) : null}
      </Sheet>
      <NameDialog
        dialog={dialog?.kind === "new" || dialog?.kind === "rename" ? dialog : null}
        onClose={close}
        onSubmit={(name) => {
          if (!dialog) return;
          close();
          if (dialog.kind === "rename") {
            void save([{ kind: "rename", id: dialog.playlist.id, name }]);
            return;
          }
          if (dialog.kind !== "new") return;
          const edit = newPlaylistEdit(name, () => crypto.randomUUID(), dialog.song ? (dialog.song.trackIds ?? [dialog.song.id]) : []);
          const onCreated = dialog.onCreated;
          void save([edit], dialog.song ? t("shell.playlists.added", { name: edit.name }) : undefined).then((saved) => saved && onCreated?.(edit.id, edit.name));
        }}
      />
    </EditorContext.Provider>
  );
};

/** The phone's one bottom sheet (UX-SHEET-01); while it slides out it keeps showing what it showed. */
const Sheet = ({ visible, onClose, testID, children }: { visible: boolean; onClose: () => void; testID: string; children: React.ReactNode }) => {
  const shown = useRef<{ testID: string; children: React.ReactNode }>({ testID, children });
  if (visible) shown.current = { testID, children };
  return (
    <MobileBottomSheet visible={visible} onClose={onClose} testID={shown.current.testID}>
      {shown.current.children}
    </MobileBottomSheet>
  );
};

const SheetRow = ({
  icon: Icon,
  label,
  detail,
  onPress,
  testID,
  destructive = false,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  detail?: string;
  onPress: () => void;
  testID: string;
  destructive?: boolean;
}) => (
  <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.sheetRow, pressed && { opacity: 0.6 }]}>
    <Icon size={22} color={destructive ? colors.danger : colors.accent} />
    <View style={{ flex: 1 }}>
      <Text style={[styles.sheetRowText, destructive && { color: colors.danger }]} numberOfLines={1}>
        {label}
      </Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  </Pressable>
);

/** The song sheet's keep row: keep, remove, or (a song a kept album or playlist holds) where it is. */
const SongKeepRow = ({ kept, trackId, onPress }: { kept: KeptView; trackId: string; onPress: () => void }) => {
  const { t } = useTranslation();
  const own = kept.entry("song", trackId);
  const held = !own && kept.holdsSong(trackId);
  const state = kept.state("song", trackId);
  const detail = state === "downloading" ? t("parrot.kept.downloadingSong") : undefined;
  if (held) return <SheetRow testID="song-kept-held" icon={CircleCheck} label={t("shell.kept.held")} detail={detail} onPress={onPress} />;
  return own ? (
    <SheetRow testID="song-unkeep" icon={CircleCheck} label={t("parrot.kept.remove")} detail={detail} onPress={onPress} />
  ) : (
    <SheetRow testID="song-keep" icon={ArrowDownToLine} label={t("parrot.kept.keep")} onPress={onPress} />
  );
};

const NameDialog = ({ dialog, onClose, onSubmit }: { dialog: Extract<Dialog, { kind: "new" | "rename" }> | null; onClose: () => void; onSubmit: (name: string) => void }) => {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  useEffect(() => setName(dialog?.kind === "rename" ? dialog.playlist.name : ""), [dialog]);
  const cleaned = cleanPlaylistName(name);
  const rename = dialog?.kind === "rename";
  return (
    <Modal visible={dialog !== null} transparent animationType="fade" onRequestClose={onClose}>
      {/* UX-CRASH-01: a crash inside the name dialog closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:playlist-name" onDismiss={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.dialogScrim}>
        <View style={styles.dialog} testID="playlist-name-dialog">
          <Text style={styles.sheetTitle}>{rename ? t("shell.playlists.renameTitle") : t("shell.playlists.newTitle")}</Text>
          <TextInput
            testID="playlist-name-input"
            autoFocus
            value={name}
            onChangeText={setName}
            maxLength={PARROT_PLAYLIST_NAME_MAX}
            placeholder={t("shell.playlists.name")}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={t("shell.playlists.name")}
            returnKeyType="done"
            onSubmitEditing={() => cleaned && onSubmit(cleaned)}
            style={styles.input}
          />
          <View style={styles.dialogButtons}>
            <Pressable testID="playlist-name-cancel" accessibilityRole="button" onPress={onClose} style={styles.dialogButton}>
              <Text style={styles.cancelText}>{t("shell.playlists.cancel")}</Text>
            </Pressable>
            <Pressable
              testID="playlist-name-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !cleaned }}
              disabled={!cleaned}
              onPress={() => onSubmit(cleaned)}
              style={[styles.dialogButton, styles.submit, !cleaned && { opacity: 0.4 }]}
            >
              <Text style={styles.submitText}>{rename ? t("shell.playlists.save") : t("shell.playlists.create")}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  noticeWrap: { position: "absolute", left: spacing.lg, right: spacing.lg, bottom: 140 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "800" },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg, minHeight: 52, paddingVertical: spacing.sm },
  sheetRowText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  detail: { color: colors.textMuted, fontSize: 13 },
  dialogScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing.xl },
  dialog: { backgroundColor: colors.surfaceRaised, borderRadius: 16, padding: spacing.xl, gap: spacing.lg },
  input: { color: colors.text, fontSize: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: spacing.md, minHeight: 48 },
  dialogButtons: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  dialogButton: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  submit: { backgroundColor: colors.accent },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: "700" },
  submitText: { color: colors.accentText, fontSize: 15, fontWeight: "800" },
});
