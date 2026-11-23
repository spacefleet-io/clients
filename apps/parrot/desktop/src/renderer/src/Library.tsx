import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Download, House, LibraryBig, ListEnd, ListMusic, Loader2, Pencil, Play, Search, Settings, Shuffle, Trash2 } from "lucide-react";
import { DesktopAppTopNav, DesktopNotificationTray, desktopTopNavIconActionClassName, desktopTopNavItemClassName, NotificationTrayContent } from "@space/desktop-shell/components";
import { createNotificationStore, useNotificationStore } from "@space/desktop-shell/services/notifications";
import { useOnline } from "@space/desktop-shell/hooks";
import { useWindowFileDrop, WindowDropOverlay } from "@space/desktop-shell/window-drop";
import { DesktopTourHost, startDesktopTour } from "@space/desktop-shell/tour";
import tourDropVideo from "./assets/tour-drop.webm";
import { isParrotAudioFile } from "@space/parrot-ingest/audio-formats";
import { RenderBoundary } from "@space/ui/render-boundary";
import { Button, Notifications, toast } from "@space/ui";
import { BadgerIconButton, badgerTopBarIcons } from "@space/ui/badger";
import { LibraryLoading } from "./LoadingMascot";
import { libraryContent } from "@space/shared/libraryContent";
import { ImportJobList, ImportJobs, importErrorPart, useImportJobs } from "./ImportJobs";
import { useExportNotifications, type ExportNotify } from "./ExportJobs";
import { MediaDetailTabs } from "@space/ui/badger/media-detail";
import { keyedNotification, shownNotification } from "./notificationText";
import {
  ParrotAlbumPageCover,
  ParrotAlbumTile,
  ParrotArtistPageCover,
  ParrotArtistTile,
  ParrotAlsoBy,
  ParrotBackButton,
  ParrotPageHeader,
  ParrotSongList,
  ParrotTileGrid,
  type ParrotNameLinks,
} from "@space/ui/parrot/library";
import { ParrotNameLink } from "@space/ui/parrot";
import { ParrotAlbumMenu, parrotCardControls, type ParrotCardPlayer } from "@space/ui/parrot/card-actions";
import { ParrotConfirmDialog, ParrotPlaylistArt, ParrotPlaylistTile, useParrotPlaylistEditor } from "@space/ui/parrot/playlists";
import { type ParrotMenuItem } from "@space/ui/parrot/menu";
import { parrotLibraryToolbarLabels, ParrotLibraryToolbar, useParrotLibraryPrefs, useParrotLibraryShown } from "@space/ui/parrot/library-toolbar";
import { ParrotKeepButton, ParrotKeepChoiceDialog, ParrotKeptLine, type ParrotKeepState } from "@space/ui/parrot/offline";
import { ParrotEditMetadataDialog, type ParrotCoverInput, type ParrotEditFields } from "@space/ui/parrot/manage";
import { ParrotNowPlaying, type ParrotLyricsFetchControl, type ParrotNowPlayingTab } from "@space/ui/parrot/screens";
import { ParrotSearchPalette } from "@space/ui/parrot/search-palette";
import { useSearchPaletteShortcut } from "@space/ui";
import { searchPaletteStrings } from "@space/shared/searchPaletteStrings";
import {
  addToQueue,
  applyPlaylistEditsLocally,
  offlineReach,
  currentEntry,
  emptyQueue,
  formatDuration,
  historyStorageKey,
  notificationsStorageKey,
  isLikedPlaylist,
  jumpTo,
  homeAlbumStart,
  parrotEditFields,
  parrotEditTarget,
  parseHistory,
  playlistEntries,
  newToUpNext,
  playNext,
  recordPlay,
  recordPosition,
  shuffleQueue,
  startQueue,
  type HistoryAlbum,
  type ListeningHistory,
  type ParrotManageTarget,
  type ParrotLyrics,
  albumPageRows,
  copyFormatName,
  type ParrotPlaylist,
  type ParrotPlaylistEdit,
  type PlayQueue,
  type KeepCopyChoice,
  type KeptKind,
  type KeptStatus,
} from "@space/parrot-core";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { ParrotImportScan, ParrotImportStatus, ParrotLibrary, ParrotState } from "../../shared/ipc";
import { applyParrotLibraryPatch } from "../../shared/libraryPatch";
import { SettingsPage, type ParrotSettingsSection } from "./AccountSettings";
import { ParrotProfileMenu, ParrotProfileSetupOverlays, useParrotDesktopProfileStore } from "./profiles";
import { FounderBanner } from "@space/ui/founder";
import { useParrotFounderStatus } from "./founder";
import AddMusic from "./AddMusic";
import { Feedback } from "./Feedback";
import Home, { EmptyMusicLibrary } from "./Home";
import { countText, type ParrotStringKey, type Translate } from "./i18n";
import { editLyricsLabels, useEditLyrics } from "./editLookups";
import { editSuggestLabels, useEditSuggest } from "./editSuggest";
import ImportReview, { coverFrameLabels } from "./ImportReview";
import Plans from "./Plans";
import Player from "./Player";
import { StreamSlotPrompt } from "./StreamSlotPrompt";
import { useSignOutWithKeyCheck } from "./SignOutKeyCheck";
import PairDevice from "./PairDevice";
import { startLoudnessPass } from "./loudness";
import { useNoteScreen } from "./noteScreen";
import { formatLocalizedStorage } from "@space/shared/format";
import { useAppPlaybackMark } from "@space/ui/app-playback-mark";

export { Feedback } from "./Feedback";
export { waveBarsFor } from "@space/ui/parrot/screens";

type Props = { t: Translate; state: ParrotState; onState: (state: ParrotState) => void };

/** A queued song is the same song as another when the ids match: the library hands out fresh rows (PAR-CARD-02). */
const songId = (track: ParrotLibraryTrack) => track.id;

/** The library's lists (the chips). Playlists have their own top-bar tab (PAR-NAV-02). */
type View = "albums" | "artists" | "songs";
/** The pages of the signed-in app: the top-bar tabs and icons, and the pages opened from them. */
type Route =
  | { kind: "home" }
  | { kind: "library" }
  | { kind: "playlists" }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "nowPlaying"; tab: ParrotNowPlayingTab }
  /**
   * Settings: the gear opens it on General; the avatar menu opens it on Account, on the profiles (UX-TOP-02), with
   * `addProfile` straight on a new one. `visit` makes each menu pick open the page afresh.
   */
  | { kind: "settings"; section?: ParrotSettingsSection; addProfile?: boolean; visit?: number };

/** The edit dialog's fields from a song's or an album's details (the album artist goes in the artist field). */
/**
 * The signed-in app in the approved design (PAR-LOOK-01, PAR-NAV-01): the top bar with the Home, Library and
 * Playlists tabs, the "+" that adds music (UX-ADD-01), the notifications and settings icons and the current profile's
 * avatar menu with Sign out (UX-TOP-02);
 * Settings holds the account (UX-SET-01); Home (PAR-HOME-01); the library with its
 * album, artist and playlist pages (PAR-PL-02); the heart on songs (PAR-PL-04); the now-playing page; and the player
 * bar at the bottom (PAR-PLAY-01).
 */
export default function Library({ t, state, onState }: Props) {
  const language = state.setup.language;
  const userId = state.user?.id ?? "anonymous";
  // WAIT-FOUND-04: the one-time founder banner above the page, read at start, after a sign-in and on coming back.
  const founder = useParrotFounderStatus(window.parrot, state.user?.id ?? null);
  // ACCT-PROF-05, UX-TOP-02: one profile store for the avatar menu and Settings ▸ Account ▸ Profiles.
  const profileStore = useParrotDesktopProfileStore(userId, typeof window.parrot?.listProfiles === "function" ? window.parrot : null);
  const settingsVisits = useRef(0);
  const openProfiles = (addProfile: boolean) => {
    settingsVisits.current += 1;
    go({ kind: "settings", section: "account", addProfile, visit: settingsVisits.current });
  };
  const [library, setLibrary] = useState<ParrotLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("albums");
  const [route, setRoute] = useState<Route>({ kind: "home" });
  // OPS-BIZ-20: each page the library opens (home, an album, an artist, settings…) counts as one opened screen.
  useNoteScreen(JSON.stringify(route));
  const [previous, setPrevious] = useState<Route[]>([]);
  const [playing, setPlaying] = useState(false);
  const [clockMs, setClockMs] = useState(0);
  const seekRef = useRef<((ms: number) => void) | null>(null);
  const toggleRef = useRef<(() => void) | null>(null);
  const [lyrics, setLyrics] = useState<{ trackId: string; lyrics: ParrotLyrics | null } | null>(null);
  /** The "Fetch lyrics" button's state for one song (PAR-LYR-05); another song starts idle. */
  const [lyricsFetch, setLyricsFetch] = useState<{ trackId: string; state: ParrotLyricsFetchControl["state"] } | null>(null);
  const [importStatus, setImportStatus] = useState<ParrotImportStatus | null>(null);
  // PAR-UP-05: the scan waiting for the user's answer in the confirm dialog.
  const [importScan, setImportScan] = useState<ParrotImportScan | null>(null);
  // UX-JOBS-02: this account's imports, for an album's Jobs tab; the album whose Jobs tab is open, if any.
  const importJobs = useImportJobs();
  const [albumJobsOpen, setAlbumJobsOpen] = useState<string | null>(null);
  const reviewImport = useCallback(() => void window.parrot.getImportScan().then(setImportScan), []);
  const [queue, setQueue] = useState<PlayQueue<ParrotLibraryTrack>>(emptyQueue);
  // The shooting stars behind every page (Home included: it renders inside this component) pause while music plays.
  useAppPlaybackMark(playing);
  const [startAt, setStartAt] = useState<{ key: number; ms: number } | null>(null);
  const [history, setHistory] = useState<ListeningHistory>(() => parseHistory(localStorage.getItem(historyStorageKey(userId))));
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchPaletteShortcut(() => setSearchOpen(true), true);
  const notifications = useMemo(() => createNotificationStore({ storageKey: notificationsStorageKey(userId) }), [userId]);
  const storedNotifications = useNotificationStore(notifications);
  // UX-I18N-01: each notification is translated when shown, so the tray follows a language change.
  const notificationList = useMemo(() => storedNotifications.map((item) => shownNotification(t, item)), [storedNotifications, t]);
  const unread = notificationList.filter((item) => !item.read).length;
  const { requestSignOut, dialog: signOutKeyCheckDialog } = useSignOutWithKeyCheck({ t, state, onSignedOut: onState });
  /** The song, album or artist waiting in the delete confirm, with what the delete would remove (PAR-LIB-03). */
  const [removing, setRemoving] = useState<{ target: ParrotManageTarget; title: string; trackCount: number } | null>(null);
  // PAR-OFFL-01/03: what is kept on this computer, and the copy question when there is one.
  const [kept, setKept] = useState<KeptStatus | null>(null);
  const [, setLibraryPrefs] = useParrotLibraryPrefs();
  const [choosing, setChoosing] = useState<{ kind: KeptKind; id: string; choices: KeepCopyChoice[] } | null>(null);
  /**
   * The edit dialog (PAR-META-16). `fields` opens the form; `current` is the library's values, so what the user or a
   * picked suggestion (PAR-META-18) changed is marked as changed.
   */
  const [editing, setEditing] = useState<{
    target: ParrotManageTarget & { kind: "track" | "album" };
    fields: ParrotEditFields;
    current: ParrotEditFields;
    coverUrl: string | null;
  } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // PAR-UP-07: artists whose photo the import stopped fetching keep their loading picture until a library read started
  // after that (by load number) is in, so a found photo replaces the shimmer without a drawn picture in between.
  const loadsStarted = useRef(0);
  const [settlingArtists, setSettlingArtists] = useState<ReadonlyMap<string, number>>(new Map());
  const load = async (refresh: boolean) => {
    setLoadError(null);
    loadsStarted.current += 1;
    const started = loadsStarted.current;
    try {
      const result = await window.parrot.getLibrary(refresh);
      if (result.ok) {
        setLibrary(result.library);
        setSettlingArtists((settling) => (settling.size ? new Map([...settling].filter(([, from]) => from > started)) : settling));
      } else setLoadError(result.error);
    } catch (error) {
      // A read that fails in main (it answered "database is not open" mid-import) shows here, not as an uncaught promise.
      console.error("[parrot:library] load failed", error);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  // UX-ADD-01: song files or folders dropped anywhere on the window are scanned like the "+" picks them, so the same
  // confirm dialog (PAR-UP-05) shows what was found; only audio files are read (PAR-UP-01). UX-ADD-02: images are
  // left out silently, any other file gets a short toast.
  const drop = useWindowFileDrop({
    getPathForFile: window.parrot.getPathForFile,
    isImportableFile: isParrotAudioFile,
    onRefused: (names) => {
      console.info(`[parrot:window-drop] refused ${names.length} file(s)`);
      toast.info(t("addMusic.dropOnlySongs"));
    },
    // An import already under way is not interrupted, like the "+" (an open dialog is handled by the shared drop).
    standAside: () => Boolean(importStatus?.running) || importStatus?.phase === "review",
    onDrop: (paths) => {
      console.info(`[parrot:window-drop] dropped ${paths.length} path(s)`);
      void window.parrot.scanImport(paths).then(
        (status) => {
          setImportStatus(status);
          if (status.phase !== "scanning") drop.stopProcessing();
        },
        (error: unknown) => {
          console.error("[parrot:window-drop] scan failed", error);
          drop.stopProcessing();
        }
      );
    },
  });

  // PAR-EMPTY-01: the empty library's "Add a folder" opens the system folder picker, then the same scan as the "+"; the
  // tour's "or pick files" (PAR-TOUR-01) does the same with songs. Resolves whether anything was picked.
  const pickAndScan = async (kind: "files" | "folders"): Promise<boolean> => {
    const paths = kind === "files" ? await window.parrot.pickFiles() : await window.parrot.pickFolders();
    console.info(`[parrot:empty-library] picked ${kind}`, paths.length);
    if (paths.length === 0) return false;
    try {
      setImportStatus(await window.parrot.scanImport(paths));
    } catch (error) {
      console.error("[parrot:empty-library] scan failed", error);
      toast.error(error instanceof Error ? error.message : String(error));
    }
    return true;
  };

  useEffect(() => {
    void load(false);
    void window.parrot.getImportStatus().then(setImportStatus);
    void window.parrot.getImportScan().then(setImportScan);
    let fetching: string[] = [];
    let phase = "";
    return window.parrot.onImportStatus((status) => {
      const phaseChanged = status.phase !== phase;
      phase = status.phase;
      setImportStatus(status);
      const nowFetching = status.fetchingArtists ?? [];
      const settled = fetching.filter((id) => !nowFetching.includes(id));
      fetching = nowFetching;
      // Cleared by the first load that starts from now on.
      if (settled.length) setSettlingArtists((settling) => new Map([...settling, ...settled.map((id) => [id, loadsStarted.current + 1] as const)]));
      // A dropped folder's overlay stays until its scan is read; the confirm dialog takes over from there.
      if (status.phase !== "scanning") drop.stopProcessing();
      // PAR-UP-05: a finished scan opens the confirm dialog; nothing uploads until the user confirms.
      if (status.phase === "review") void window.parrot.getImportScan().then(setImportScan);
      // PAR-UP-03: each song the import stores is published at once and comes as a patch (below, #2509); the import's
      // end shows the library main holds, read back from the server no more. A stopped import (UX-JOBS-02) keeps
      // what it already published, so its end shows the library too.
      if (status.phase === "done" || status.phase === "cancelled") void load(false);
      // A finished import says so in the tray, once (UX-JOBS-01).
      if (!phaseChanged) return;
      if (status.phase === "done") {
        const counts = { imported: status.imported, skipped: status.skipped, failed: status.failed };
        notifications.push(keyedNotification(t, "success", { key: "notifications.importDone" }, { key: "import.done", vars: counts }));
      }
      if (status.phase === "failed") notifications.push(keyedNotification(t, "error", { key: "notifications.importFailed" }, importErrorPart(status.error ?? "")));
    });
  }, []);
  useEffect(() => {
    void window.parrot.getKept().then(setKept);
    return window.parrot.onKept(setKept);
  }, []);

  const saveHistory = useCallback(
    (change: (history: ListeningHistory) => ListeningHistory) =>
      setHistory((current) => {
        const next = change(current);
        if (next !== current) localStorage.setItem(historyStorageKey(userId), JSON.stringify(next));
        return next;
      }),
    [userId]
  );

  const keptSongs = useMemo(() => new Map((kept?.songs ?? []).map((song) => [song.trackId, song.onDevice])), [kept]);
  const keptEntry = (kind: KeptKind, id: string) => kept?.entries.find((entry) => entry.kind === kind && entry.id === id);
  const keepState = (kind: KeptKind, id: string): ParrotKeepState => {
    const entry = keptEntry(kind, id);
    if (entry) return entry.done < entry.total ? "downloading" : "kept";
    // A song a kept album or playlist holds shows where it is (PAR-OFFL-01).
    if (kind === "song" && keptSongs.has(id)) return keptSongs.get(id) ? "kept" : "downloading";
    return "off";
  };
  /** Keeps (asking which copy only when there is a real choice, PAR-OFFL-02) or removes from this computer. */
  const toggleKeep = async (kind: KeptKind, id: string) => {
    if (keptEntry(kind, id)) {
      setKept(await window.parrot.unkeep(kind, id));
      return;
    }
    const choices = await window.parrot.keepChoices(kind, id);
    if (choices.length >= 2) setChoosing({ kind, id, choices });
    else setKept(await window.parrot.keep(kind, id, null));
  };
  const keepButton = (kind: KeptKind, id: string, size: "sm" | "md" = "md", testId?: string) => (
    <ParrotKeepButton
      state={keepState(kind, id)}
      held={kind === "song" && !keptEntry(kind, id) && keptSongs.has(id)}
      labels={{ keep: t("kept.keep"), remove: t("kept.remove"), held: t("kept.held") }}
      onToggle={() => void toggleKeep(kind, id)}
      size={size}
      testId={testId}
    />
  );
  const keptLine = (kind: KeptKind, id: string) => {
    const entry = keptEntry(kind, id);
    if (!entry) return null;
    return <ParrotKeptLine text={entry.done < entry.total ? t("kept.downloading", { done: entry.done, total: entry.total }) : t("kept.line", { size: formatLocalizedStorage(entry.bytes, language) })} />;
  };

  const albums = library?.albums ?? [];
  const artists = library?.artists ?? [];
  const tracks = useMemo(() => (library?.tracks ?? []).filter((track) => track.fileId), [library]);
  // PAR-PLAY-03 item 2: songs imported without a ReplayGain tag are measured in the background, once.
  useEffect(() => startLoudnessPass(tracks, setLibrary), [tracks]);
  // UX-WAIT-04: the empty library is a verdict, never a default. Until the first load answers (`library` still null),
  // Home and the library page show the loading screen; only an opened library with no song is empty.
  const content = libraryContent({ itemCount: tracks.length, settled: library !== null });
  // UX-LIBTAB-01: an empty library cannot be opened, nor its playlists. The Library and Playlists tabs are greyed out
  // once the opened library holds no song, and open again as soon as the first song lands (the library reloads on every
  // change); a window left on either (its last song deleted) goes back to Home.
  const libraryClosed = content === "empty";
  const onLibraryRoute =
    route.kind === "library" || route.kind === "album" || route.kind === "artist" || route.kind === "playlists" || route.kind === "playlist";
  useEffect(() => {
    if (!libraryClosed || !onLibraryRoute) return;
    console.info("[parrot-nav] library empty: back to home", JSON.stringify({ from: route.kind }));
    setPrevious([]);
    setRoute({ kind: "home" });
  }, [libraryClosed, onLibraryRoute, route.kind]);
  // PAR-LIB-06: the open tab's list as its sort and filters leave them.
  const likedSongIds = useMemo(() => new Set((library?.playlists ?? []).find((playlist) => isLikedPlaylist(playlist.id))?.trackIds ?? []), [library]);
  const shown = useParrotLibraryShown({ tab: view, albums, artists, songs: tracks, history, likedSongIds });
  // PAR-OFFL-04: offline, what is not kept on this computer is greyed out and does not play. Null while online.
  const online = useOnline();
  const reach = useMemo(
    () => (online ? null : offlineReach(new Set([...keptSongs].filter(([, onDevice]) => onDevice).map(([id]) => id)), tracks)),
    [online, keptSongs, tracks]
  );
  const songAway = reach ? (track: { id: string }) => !reach.song(track.id) : undefined;
  const playingTrack = currentEntry(queue)?.track;
  const playingId = playingTrack?.id;
  // PAR-LYR-01: the automatic lookup keeps lyrics in the background; the playing song's are read again when it does, and
  // when the song enters or leaves the lookup's queue (PAR-LYR-06: "Looking for lyrics…" while it is in it).
  const [lyricsChanges, setLyricsChanges] = useState(0);
  useEffect(() => window.parrot.onLyricsChanged(() => setLyricsChanges((count) => count + 1)), []);
  // PAR-META-20: the albums the automatic cover pass still has to ask; their covers shimmer until it answers.
  const [coversWaiting, setCoversWaiting] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void window.parrot.getCoversWaiting().then((ids) => setCoversWaiting(new Set(ids)));
    return window.parrot.onCoversWaiting((ids) => setCoversWaiting(new Set(ids)));
  }, []);
  // PAR-META-15: the automatic artist-photo lookup kept new photos; the opened library is read again to show them.
  useEffect(() => window.parrot.onLibraryChanged(() => void load(false)), []);
  // #2509: a publish's changes are applied to the library shown; a window that shows another version reads it whole.
  const shownLibrary = useRef(library);
  shownLibrary.current = library;
  useEffect(
    () =>
      window.parrot.onLibraryPatch((patch) => {
        const current = shownLibrary.current;
        if (!current || current.snapshotVersion !== patch.baseVersion) return void load(false);
        loadsStarted.current += 1;
        const started = loadsStarted.current;
        const next = applyParrotLibraryPatch(current, patch);
        shownLibrary.current = next;
        setLibrary(next);
        setSettlingArtists((settling) => (settling.size ? new Map([...settling].filter(([, from]) => from > started)) : settling));
      }),
    []
  );
  // PAR-LYR-05: a playing song never looked up (no row, nothing pending) is asked for at once, once, so its tab shows
  // "Looking for lyrics…" rather than an empty answer (PAR-META-20). PAR-COPY-01: the window never looks it up itself;
  // the automatic pass asks it next and keeps the answer in the library, which this tab then reads.
  const askedPlayingLyrics = useRef(new Set<string>());
  useEffect(() => {
    if (!playingId) return;
    let cancelled = false;
    void window.parrot.getLyrics(playingId).then((found) => {
      if (cancelled) return;
      setLyrics({ trackId: playingId, lyrics: found });
      if (found === null && !askedPlayingLyrics.current.has(playingId)) {
        askedPlayingLyrics.current.add(playingId);
        void window.parrot.wantLyrics(playingId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [playingId, library, lyricsChanges]);
  const fetchPlayingLyrics = (trackId: string) => {
    setLyricsFetch({ trackId, state: "busy" });
    void window.parrot.fetchLyrics(trackId).then(
      (result) => {
        if (!result.ok) {
          console.warn(`[parrot] lyrics fetch failed for song ${trackId}: ${result.error}`);
          setLyricsFetch({ trackId, state: "failed" });
          return;
        }
        setLyricsFetch({ trackId, state: result.outcome === "none" ? "none" : "idle" });
        if (result.lyrics) setLyrics({ trackId, lyrics: result.lyrics });
      },
      (error: unknown) => {
        console.warn(`[parrot] lyrics fetch failed for song ${trackId}: ${String(error)}`);
        setLyricsFetch({ trackId, state: "failed" });
      }
    );
  };
  const coverFor = (albumId: string) => albums.find((album) => album.id === albumId);
  const playlists = library?.playlists ?? [];
  const playlistSongs = (playlist: ParrotPlaylist) => playlistEntries(playlist, tracks).map((entry) => entry.song);
  /** Shows the edits at once, saves them into the encrypted library (PAR-PL-03), and puts the playlists back if the save fails. */
  const playlistEditor = useParrotPlaylistEditor<ParrotLibraryTrack>({
    playlists,
    save: async (edits: ParrotPlaylistEdit[]) => {
      const before = library?.playlists;
      if (!before) return { ok: false, error: "library not loaded" };
      setLibrary((current) => current && { ...current, playlists: applyPlaylistEditsLocally(current.playlists, edits, Date.now()) });
      const result = await window.parrot.editPlaylists(edits);
      if (result.ok) {
        setLibrary(result.library);
        return { ok: true };
      }
      setLibrary((current) => current && { ...current, playlists: before });
      return result;
    },
    t: (key, vars) => t(key as Parameters<Translate>[0], vars),
    detail: (playlist) => countText(language, t, "song", playlistSongs(playlist).length),
    notify: ({ level, title, message, titleKey, titleVars }) =>
      notifications.push(titleKey ? keyedNotification(t, level, { key: titleKey as ParrotStringKey, vars: titleVars }, message) : { level, title, message }),
    onCreated: (id) => open({ kind: "playlist", id }),
    onDeleted: (id) => {
      if (route.kind === "playlist" && route.id === id) back();
    },
  });
  const playlistName = playlistEditor.name;
  const like = (track: { id: string }) => playlistEditor.heart(track.id);
  /** "Download everything" (Settings, OFFL-FILE-01) runs in the background: its end shows in the tray. */
  const notifyExport: ExportNotify = (level, title, message) => notifications.push(keyedNotification(t, level, title, message));
  useExportNotifications(language, notifyExport);
  /**
   * A song row's "Add to queue" (PAR-CARD-02), heart and "Add to playlist", plus edit (PAR-META-16) and delete outside a
   * playlist (PAR-LIB-03) or remove inside one.
   */
  const songActions = (remove?: (track: ParrotLibraryTrack, index: number) => void) => (track: ParrotLibraryTrack, index: number) => (
    <>
      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("card.addToQueue")} title={t("card.addToQueue")} onClick={() => enqueue([track], "end")} data-testid="song-add-to-queue">
        <ListEnd className="size-4" aria-hidden />
      </Button>
      {playlistEditor.songActions(remove)(track, index)}
      {keepButton("song", track.id, "sm", "song-keep")}
      {!remove && (
        <>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("manage.edit")} title={t("manage.edit")} onClick={() => void askEdit({ kind: "track", id: track.id })} data-testid="song-edit">
            <Pencil className="size-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("manage.delete")} title={t("manage.delete")} onClick={() => void askDelete({ kind: "track", id: track.id }, track.title)} data-testid="song-delete">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </>
      )}
    </>
  );
  /** Counts what the delete would remove, then asks (PAR-LIB-03). */
  const askDelete = async (target: ParrotManageTarget, title: string) => {
    const preview = await window.parrot.previewDelete(target);
    if (!preview.ok) {
      notifications.push(keyedNotification(t, "error", { key: "manage.deleteFailed", vars: { reason: preview.error } }, preview.error));
      return;
    }
    setRemoving({ target, title, trackCount: preview.trackCount });
  };
  const confirmDelete = async () => {
    if (!removing) return;
    const { target } = removing;
    setRemoving(null);
    const result = await window.parrot.deleteFromLibrary(target);
    if (!result.ok) {
      notifications.push(keyedNotification(t, "error", { key: "manage.deleteFailed", vars: { reason: result.error } }, result.error));
      return;
    }
    setLibrary(result.library);
    if ((route.kind === "album" || route.kind === "artist") && route.id === target.id) back();
  };
  const deleteBody = (pending: { target: ParrotManageTarget; trackCount: number }) =>
    pending.target.kind === "track"
      ? t("manage.deleteBody.track")
      : t(`manage.deleteBody.${pending.target.kind}.${new Intl.PluralRules(language).select(pending.trackCount) === "one" ? "one" : "other"}`, { count: pending.trackCount });
  /** Opens the edit dialog with the song's or the album's current details (PAR-META-16). */
  const askEdit = async (target: ParrotManageTarget & { kind: "track" | "album" }, coverUrl: string | null = null) => {
    const values = await window.parrot.getEditValues(target);
    if (!values) {
      notifications.push(keyedNotification(t, "error", { key: "manage.saveFailed", vars: { reason: "not found" } }, target.id));
      return;
    }
    setEditError(null);
    const fields = parrotEditFields(values);
    setEditing({ target, fields, current: fields, coverUrl });
  };
  // PAR-META-18: the fields' connected autocomplete; PAR-LYR-05: the dialog's Lyrics section. Nothing is saved before Save.
  const editSuggest = useEditSuggest({ artists, albums, tracks: library?.tracks ?? [] });
  const editLyrics = useEditLyrics({
    target: editing?.target ?? null,
    songIds: editing?.target.kind === "album" ? tracks.filter((track) => track.albumId === editing.target.id).map((track) => track.id) : [],
    lyricsChanges,
  });
  const saveEdit = async (fields: ParrotEditFields, cover: ParrotCoverInput | null) => {
    if (!editing) return;
    const { target } = editing;
    setEditBusy(true);
    setEditError(null);
    const result = await window.parrot.editDetails(
      parrotEditTarget(target, fields),
      target.kind === "album" ? cover : null
    );
    setEditBusy(false);
    if (!result.ok) {
      setEditError(t("manage.saveFailed", { reason: result.error }));
      return;
    }
    setLibrary(result.library);
    setEditing(null);
  };

  // Every song that starts goes to the front of this computer's history (Home's "Jump back in").
  const playingKey = currentEntry(queue)?.key;
  useEffect(() => {
    if (playingTrack) saveHistory((current) => recordPlay(current, playingTrack, Date.now()));
  }, [playingKey]);

  const open = (next: Route) => {
    setPrevious((stack) => [...stack, route]);
    setRoute(next);
  };
  const back = () => {
    setRoute(previous.at(-1) ?? { kind: "home" });
    setPrevious((stack) => stack.slice(0, -1));
  };
  const go = (next: Route) => {
    setPrevious([]);
    setRoute(next);
  };
  const play = (list: ParrotLibraryTrack[], index: number, shuffle = queue.shuffle) => {
    setStartAt(null);
    setQueue((current) => startQueue(list, index, { ...current, shuffle }));
  };
  const playAlbum = (albumId: string, entry: HistoryAlbum | null, shuffle: boolean) => {
    const start = homeAlbumStart(tracks, albumId, entry, shuffle);
    const next = startQueue(start.tracks, start.index, { ...queue, shuffle });
    setQueue(next);
    const first = currentEntry(next);
    setStartAt(start.startMs > 0 && first ? { key: first.key, ms: start.startMs } : null);
  };
  /**
   * Play next ("next") or Add to queue ("end"): a song is in Up next at most once (PAR-CARD-02), so the songs already
   * playing or up next are left out, and when none is left the usual short notice says so.
   */
  const enqueue = (songs: ParrotLibraryTrack[], where: "next" | "end") => {
    const add = where === "next" ? playNext : addToQueue;
    if (songs.length > 0 && newToUpNext(queue, songs, songId).length === 0) toast.info(t("card.alreadyInUpNext"));
    setQueue((current) => add(current, songs, songId));
  };
  // A card's Play, Shuffle, Play next and Add to queue (PAR-CARD-01) on the same queue as the rest of the app.
  const cardPlayer: ParrotCardPlayer<ParrotLibraryTrack> = {
    play: (songs) => play(songs, 0, false),
    shuffle: (songs) => {
      setStartAt(null);
      setQueue((current) => shuffleQueue(songs, current));
    },
    playNext: (songs) => enqueue(songs, "next"),
    addToQueue: (songs) => enqueue(songs, "end"),
  };
  const albumControls = (album: { id: string; artistId: string; title?: string; coverUrl?: string | null }, more: ParrotMenuItem[] = []) =>
    parrotCardControls(
      t,
      () => tracks.filter((track) => track.albumId === album.id),
      cardPlayer,
      {
        onGoToArtist: album.artistId ? () => open({ kind: "artist", id: album.artistId }) : undefined,
        onAddToPlaylist: playlistEditor.addTo,
        onEdit: () => void askEdit({ kind: "album", id: album.id }, album.coverUrl ?? null),
      },
      more
    );
  const artistControls = (artist: { id: string }) =>
    parrotCardControls(t, () => tracks.filter((track) => track.artistId === artist.id), cardPlayer, { onAddToPlaylist: playlistEditor.addTo });
  const playlistControls = (playlist: ParrotPlaylist) => parrotCardControls(t, () => playlistSongs(playlist), cardPlayer);
  const songLabels = {
    song: t("library.song"),
    artist: t("library.artist"),
    album: t("library.album"),
    time: t("library.time"),
    unknownArtist: t("library.unknownArtist"),
    play: () => t("player.play"),
    missing: t("library.missingTrack"),
    unidentified: t("library.unidentified"),
  };

  const playlistTiles = (list = playlists) => (
    <ParrotTileGrid testId="library-playlists">
      {list.map((playlist) => (
        <ParrotPlaylistTile
          key={playlist.id}
          id={playlist.id}
          name={playlistName(playlist)}
          liked={isLikedPlaylist(playlist.id)}
          detail={countText(language, t, "song", playlistSongs(playlist).length)}
          onOpen={() => open({ kind: "playlist", id: playlist.id })}
          unavailable={reach ? !reach.playlist(playlistSongs(playlist).map((song) => song.id)) : false}
          controls={playlistSongs(playlist).length > 0 ? playlistControls(playlist) : undefined}
          testId="library-playlist"
        />
      ))}
      {playlistEditor.newTile}
    </ParrotTileGrid>
  );

  // PAR-UP-07: what the running import is still adding or fetching.
  const importingAlbums = new Set(importStatus?.importingAlbums ?? []);
  const fetchingArtists = new Set(importStatus?.fetchingArtists ?? []);
  const albumImporting = (album: (typeof albums)[number]) => importingAlbums.has(album.id);
  // PAR-META-20: a cover still on its way (the import, or the automatic cover pass) shimmers; none means "no cover".
  const albumCoverFetching = (albumId: string) => !coverFor(albumId)?.coverUrl && (importingAlbums.has(albumId) || coversWaiting.has(albumId));
  const artistFetching = (artist: (typeof artists)[number]) => !artist.pictureUrl && (fetchingArtists.has(artist.id) || settlingArtists.has(artist.id));
  const albumTile = (album: (typeof albums)[number]) => {
    const playingHere = playingTrack?.albumId === album.id;
    return (
      <ParrotAlbumTile
        key={album.id}
        album={album}
        src={album.coverThumbUrl}
        unknownArtist={t("library.unknownArtist")}
        playing={playingHere}
        animated={playingHere && playing}
        onOpen={() => open({ kind: "album", id: album.id })}
        onOpenArtist={album.artistId ? () => open({ kind: "artist", id: album.artistId! }) : undefined}
        unavailable={reach ? !reach.album(album.id) : false}
        controls={albumControls(album)}
        importing={albumImporting(album) ? t("addMusic.importingAlbum") : null}
        fetching={albumCoverFetching(album.id)}
        testId="library-album"
      />
    );
  };
  const albumTiles = (list: typeof albums) => <ParrotTileGrid testId="library-albums">{list.map(albumTile)}</ParrotTileGrid>;
  // PAR-NAV-05: an artist or album named on a song row opens its page.
  const nameLinks: ParrotNameLinks = { onOpenArtist: (id) => open({ kind: "artist", id }), onOpenAlbum: (id) => open({ kind: "album", id }) };

  const libraryPage = () => {
    if (content === "empty") return <EmptyMusicLibrary t={t} onAddMusic={() => setAddOpen(true)} onAddFolder={() => void pickAndScan("folders")} />;
    const totals = { albums: { kind: "album" as const, n: albums.length }, artists: { kind: "artist" as const, n: artists.length }, songs: { kind: "song" as const, n: tracks.length } };
    // PAR-LIB-06: the quiet counts; with a filter on, how many of the open tab's are shown.
    const counts = shown.filtered
      ? [{ n: shown.shownCount, text: t("library.shownOf", { shown: shown.shownCount, total: countText(language, t, totals[view].kind, totals[view].n) }) }]
      : [totals.albums, totals.songs, totals.artists].map(({ kind, n }) => ({ n, text: countText(language, t, kind, n) }));
    return (
      <section>
        <ParrotLibraryToolbar
          tab={view}
          onTab={setView}
          counts={counts}
          prefs={shown.prefs}
          onPrefs={shown.setPrefs}
          genres={shown.genres}
          decades={shown.decades}
          labels={parrotLibraryToolbarLabels(t)}
          // The page scrolls inside <main>, whose 32px top padding the sticky top counts from: -32 pins the row flush
          // under the top bar.
          pinTop={-32}
          className="-mx-10 -mt-4 mb-4 px-10"
        />
        {/* UX-CRASH-01: a crashing list blanks only itself; the row keeps working and switching clears it;
            "Try again" reads the library afresh first. */}
        <RenderBoundary name={`library-list:${view}`} resetKey={view} onRetry={() => load(true)}>
          {() => shown.shownCount === 0 ? (
            <p className="text-muted-foreground" data-testid="library-no-match">
              {t("library.noFilterMatch")}
            </p>
          ) : view === "albums" ? (
            albumTiles(shown.shownAlbums)
          ) : view === "artists" ? (
            <ParrotTileGrid kind="artist" testId="library-artists">
              {shown.shownArtists.map((artist) => (
                <ParrotArtistTile
                  key={artist.id}
                  id={artist.id}
                  src={artist.pictureThumbUrl}
                  name={artist.name}
                  detail={`${countText(language, t, "album", artist.albumCount)} · ${countText(language, t, "song", artist.trackCount)}`}
                  onOpen={() => open({ kind: "artist", id: artist.id })}
                  unavailable={reach ? !reach.artist(artist.id) : false}
                  controls={artistControls(artist)}
                  fetching={artistFetching(artist)}
                  testId="library-artist"
                />
              ))}
            </ParrotTileGrid>
          ) : (
            <ParrotSongList
              tracks={shown.shownSongs}
              playingId={playingTrack?.id}
              playing={playing}
              showAlbum
              labels={songLabels}
              onPlay={(i) => play(shown.shownSongs, i)}
              actions={songActions()}
              unavailable={songAway}
              links={nameLinks}
            />
          )}
        </RenderBoundary>
      </section>
    );
  };

  const page = () => {
    if (route.kind === "settings") {
      return (
        <SettingsPage
          key={route.visit ?? 0}
          initialSection={route.section}
          profileStore={profileStore}
          profilesStartWith={route.addProfile ? "add" : undefined}
          t={t}
          email={state.user?.email ?? ""}
          userId={userId}
          language={language}
          onState={onState}
          onPlan={() => setPlanOpen(true)}
          planOpen={planOpen}
          onPair={() => setPairOpen(true)}
          onFeedback={() => setFeedbackOpen(true)}
          onTour={() => {
            startDesktopTour();
            go({ kind: "home" });
          }}
          onRefresh={() => void load(true)}
          onSignOut={() => void requestSignOut()}
          describeKept={(kind, id) => {
            if (kind === "album") {
              const album = albums.find((item) => item.id === id);
              return album ? { title: album.title, subtitle: album.artistName, imagePath: album.coverThumbUrl ?? album.coverUrl } : null;
            }
            if (kind === "playlist") {
              const playlist = playlists.find((item) => item.id === id);
              return playlist ? { title: playlistName(playlist) } : null;
            }
            const track = library?.tracks.find((item) => item.id === id);
            const cover = track ? coverFor(track.albumId) : undefined;
            return track ? { title: track.title, subtitle: track.artistName, imagePath: cover?.coverThumbUrl ?? cover?.coverUrl } : null;
          }}
        />
      );
    }
    // Not opened yet: the loading screen above stands in for the page (UX-WAIT-04).
    if (!library) return null;
    if (route.kind === "home") {
      return (
        <Home
          t={t}
          language={language}
          albums={albums}
          artists={artists}
          content={content}
          tracks={tracks}
          history={history}
          playingTrack={playingTrack}
          playing={playing}
          positionMs={clockMs}
          onToggle={() => toggleRef.current?.()}
          onOpenAlbum={(id) => open({ kind: "album", id })}
          onOpenArtist={(id) => open({ kind: "artist", id })}
          onPlayAlbum={playAlbum}
          albumControls={albumControls}
          artistControls={artistControls}
          albumImporting={albumImporting}
          albumCoverFetching={albumCoverFetching}
          artistFetching={artistFetching}
          onAddMusic={() => setAddOpen(true)}
          onAddFolder={() => void pickAndScan("folders")}
          onSeeAll={(next, sort) => {
            // "See all" shows every album in that order, so a filter left on from before is cleared (PAR-HOME-01).
            if (sort) setLibraryPrefs("albums", { sort, filters: {} });
            setView(next);
            go({ kind: "library" });
          }}
        />
      );
    }
    if (route.kind === "nowPlaying") {
      if (!playingTrack) return null;
      const album = coverFor(playingTrack.albumId);
      return (
        <ParrotNowPlaying
          like={like(playingTrack)}
          track={playingTrack}
          lyrics={lyrics?.trackId === playingTrack.id ? lyrics.lyrics : undefined}
          fetchLyrics={{
            state: lyricsFetch?.trackId === playingTrack.id ? lyricsFetch.state : "idle",
            onFetch: () => fetchPlayingLyrics(playingTrack.id),
            labels: {
              body: t("nowPlaying.fetchLyricsBody"),
              button: t("nowPlaying.fetchLyrics"),
              none: t("nowPlaying.fetchLyricsNone"),
              failed: t("nowPlaying.fetchLyricsFailed"),
            },
          }}
          positionMs={clockMs}
          onSeek={(ms) => seekRef.current?.(ms)}
          coverSrc={album?.coverUrl}
          coverFetching={albumCoverFetching(playingTrack.albumId)}
          playing={playing}
          tab={route.tab}
          onTab={(tab) => setRoute({ kind: "nowPlaying", tab })}
          entries={queue.entries}
          position={queue.position}
          onJump={(index) => setQueue((current) => jumpTo(current, index))}
          coverFor={(albumId) => coverFor(albumId)?.coverThumbUrl}
          onOpenAlbum={() => open({ kind: "album", id: playingTrack.albumId })}
          onOpenArtist={(id) => open({ kind: "artist", id })}
          labels={{
            lyrics: t("player.lyrics"),
            queue: t("nowPlaying.upNext"),
            about: t("nowPlaying.about"),
            noLyricsTitle: t("nowPlaying.noLyricsTitle"),
            noLyricsBody: t("nowPlaying.noLyricsBody"),
            noLyricsFoundTitle: t("nowPlaying.noLyricsFoundTitle"),
            noLyricsFoundBody: t("nowPlaying.noLyricsFoundBody"),
            searchingLyricsTitle: t("nowPlaying.searchingLyricsTitle"),
            searchingLyricsBody: t("nowPlaying.searchingLyricsBody"),
            syncedLyricsSource: t("nowPlaying.syncedLyricsSource"),
            plainLyricsSource: t("nowPlaying.plainLyricsSource"),
            fetchedSyncedLyricsSource: t("nowPlaying.fetchedSyncedLyricsSource"),
            fetchedPlainLyricsSource: t("nowPlaying.fetchedPlainLyricsSource"),
            nothingNext: t("nowPlaying.nothingNext"),
            nowPlaying: t("nowPlaying.now"),
            aboutRows: [
              { label: t("library.album"), value: playingTrack.albumTitle, onOpen: () => open({ kind: "album", id: playingTrack.albumId }) },
              {
                label: t("library.artist"),
                value: playingTrack.artistName || t("library.unknownArtist"),
                onOpen: playingTrack.artistId ? () => open({ kind: "artist", id: playingTrack.artistId! }) : undefined,
              },
              { label: t("nowPlaying.track"), value: playingTrack.number ? String(playingTrack.number) : "" },
              { label: t("nowPlaying.year"), value: album?.year ? String(album.year) : "" },
              { label: t("nowPlaying.length"), value: playingTrack.durationMs ? formatDuration(playingTrack.durationMs) : "" },
              { label: t("nowPlaying.format"), value: playingTrack.mime ? copyFormatName(playingTrack.mime) : "" },
            ].filter((row) => row.value),
          }}
        />
      );
    }
    if (route.kind === "album") {
      const album = albums.find((row) => row.id === route.id);
      const songs = tracks.filter((track) => track.albumId === route.id);
      const playingHere = playingTrack?.albumId === route.id;
      // UX-JOBS-02: the imports that touched this album, under a Jobs tab like a Badger title's; no tabs without one.
      const albumJobs = (importJobs ?? []).filter((job) => job.albumIds?.includes(route.id));
      const jobsTab = albumJobs.length > 0 && albumJobsOpen === route.id;
      return (
        <section data-testid="library-album-page">
          <ParrotBackButton label={t("back")} onClick={back} />
          <ParrotPageHeader
            cover={<ParrotAlbumPageCover id={route.id} src={album?.coverUrl} fetching={albumCoverFetching(route.id)} title={album?.title} playing={playingHere} animated={playingHere && playing} />}
            kicker={t("library.album")}
            title={album?.title}
            titleTestId="album-title"
            detail={
              <>
                <ParrotNameLink
                  className="font-semibold text-foreground"
                  testId="album-artist-link"
                  onOpen={album?.artistId ? () => open({ kind: "artist", id: album.artistId! }) : undefined}
                >
                  {album?.artistName || t("library.unknownArtist")}
                </ParrotNameLink>
                {album?.year ? ` · ${album.year}` : ""} · {countText(language, t, "song", songs.length)}
                {keptLine("album", route.id)}
              </>
            }
            actions={
              <div className="flex items-center gap-2.5">
                <PlayAll t={t} disabled={songs.length === 0} onClick={() => play(songs, 0)} />
                <Button variant="secondary" disabled={songs.length === 0} onClick={() => cardPlayer.shuffle(songs)} data-testid="album-shuffle">
                  <Shuffle className="mr-2 h-4 w-4" aria-hidden />
                  {t("card.shuffle")}
                </Button>
                {playlistEditor.heartAll(songs, { testId: "album-like" })}
                <ParrotAlbumMenu
                  controls={albumControls(album ?? { id: route.id, artistId: "" }, [
                    { id: "keep", label: keptEntry("album", route.id) ? t("kept.remove") : t("kept.keep"), icon: <Download className="h-4 w-4" />, onSelect: () => void toggleKeep("album", route.id), separatorBefore: true },
                    { id: "delete", label: t("manage.delete"), icon: <Trash2 className="h-4 w-4" />, destructive: true, onSelect: () => void askDelete({ kind: "album", id: route.id }, album?.title ?? "") },
                  ])}
                />
              </div>
            }
          />
          {albumJobs.length > 0 ? (
            <MediaDetailTabs
              label={t("album.tabs.label")}
              active={jobsTab ? "jobs" : "songs"}
              onChange={(tab) => setAlbumJobsOpen(tab === "jobs" ? route.id : null)}
              tabs={[
                { id: "songs", label: t("album.tabs.songs") },
                {
                  id: "jobs",
                  label: t("jobs.title"),
                  icon: albumJobs.some((job) => job.status.running) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : undefined,
                },
              ]}
            />
          ) : null}
          {jobsTab ? (
            <div className="mt-6" data-testid="album-jobs">
              <ImportJobList t={t} language={language} jobs={albumJobs} onReview={reviewImport} />
            </div>
          ) : (
            // The album's songs the user does not have sit greyed between them, never played (PAR-LIB-05).
            <ParrotSongList
              tracks={songs}
              rows={albumPageRows(songs, album?.tracklist)}
              playingId={playingTrack?.id}
              playing={playing}
              showAlbum={false}
              labels={songLabels}
              onPlay={(i) => play(songs, i)}
              actions={songActions()}
              unavailable={songAway}
              links={nameLinks}
            />
          )}
          <ParrotAlsoBy
            title={t("album.alsoBy", { artist: album?.artistName ?? "" })}
            albums={album?.artistId ? albums.filter((other) => other.artistId === album.artistId && other.id !== album.id) : []}
            tile={albumTile}
          />
        </section>
      );
    }
    if (route.kind === "artist") {
      const artist = artists.find((row) => row.id === route.id);
      const artistAlbums = albums.filter((album) => album.artistId === route.id);
      const songs = tracks.filter((track) => track.artistId === route.id);
      return (
        <section data-testid="library-artist-page">
          <ParrotBackButton label={t("back")} onClick={back} />
          <ParrotPageHeader
            cover={
              <ParrotArtistPageCover
                id={route.id}
                src={artist?.pictureUrl}
                credit={artist?.pictureCredit}
                creditLabel={(author, licence) => t("library.photoCredit", { author, licence })}
                fetching={artist ? artistFetching(artist) : false}
              />
            }
            kicker={t("library.artist")}
            title={artist?.name}
            titleTestId="artist-title"
            detail={`${countText(language, t, "album", artistAlbums.length)} · ${countText(language, t, "song", songs.length)}`}
            actions={
              <>
                <PlayAll t={t} disabled={songs.length === 0} onClick={() => play(songs, 0)} />
                <DeleteButton t={t} onClick={() => void askDelete({ kind: "artist", id: route.id }, artist?.name ?? "")} />
              </>
            }
          />
          {albumTiles(artistAlbums)}
        </section>
      );
    }
    if (route.kind === "playlists") {
      return (
        <section data-testid="playlists-page">
          {playlists.length === 0 && (
            <p className="mb-6 text-muted-foreground" data-testid="playlists-empty">
              {t("playlists.empty")}
            </p>
          )}
          {playlistTiles()}
        </section>
      );
    }
    if (route.kind === "playlist") {
      const playlist = playlists.find((row) => row.id === route.id);
      if (!playlist) {
        return (
          <section data-testid="playlist-page">
            <ParrotBackButton label={t("back")} onClick={back} />
            <p className="text-muted-foreground">{t("playlists.empty")}</p>
          </section>
        );
      }
      const liked = isLikedPlaylist(playlist.id);
      const entries = playlistEntries(playlist, tracks);
      const songs = entries.map((entry) => entry.song);
      return (
        <section data-testid="playlist-page">
          <ParrotBackButton label={t("back")} onClick={back} />
          <ParrotPageHeader
            cover={<ParrotPlaylistArt id={playlist.id} liked={liked} className="w-56 shadow-2xl shadow-black/50" />}
            kicker={t("playlists.kicker")}
            title={playlistName(playlist)}
            titleTestId="playlist-title"
            detail={
              <>
                {liked ? `${t("playlists.likedBody")} · ${countText(language, t, "song", songs.length)}` : countText(language, t, "song", songs.length)}
                {keptLine("playlist", playlist.id)}
              </>
            }
            actions={
              <>
                <PlayAll t={t} disabled={songs.length === 0} onClick={() => play(songs, 0, false)} />
                {keepButton("playlist", playlist.id)}
                <Button variant="secondary" disabled={songs.length === 0} onClick={() => play(songs, Math.floor(Math.random() * songs.length), true)} data-testid="playlist-shuffle">
                  <Shuffle className="mr-2 h-4 w-4" aria-hidden />
                  {t("player.shuffle")}
                </Button>
                {playlistEditor.pageActions(playlist)}
              </>
            }
          />
          {songs.length === 0 ? (
            <p className="text-muted-foreground" data-testid="playlist-empty">
              {t("playlists.emptyPlaylist")}
            </p>
          ) : (
            <ParrotSongList
              tracks={songs}
              playingId={playingTrack?.id}
              playing={playing}
              showAlbum
              labels={songLabels}
              onPlay={(i) => play(songs, i)}
              actions={songActions((track, index) => playlistEditor.removeSong(playlist, track.id, entries[index]?.position ?? index))}
              testId="playlist-tracks"
              unavailable={songAway}
              links={nameLinks}
            />
          )}
        </section>
      );
    }
    return libraryPage();
  };

  const tab = (kind: "home" | "library" | "playlists", label: string, Icon: typeof House, testId: string) => {
    const disabled = kind !== "home" && libraryClosed;
    const active =
      !disabled &&
      (route.kind === kind || (kind === "library" && (route.kind === "album" || route.kind === "artist")) || (kind === "playlists" && route.kind === "playlist"));
    return (
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        className={desktopTopNavItemClassName({ isActive: active, disabled })}
        onClick={() => go({ kind })}
        data-testid={testId}
      >
        <Icon className="size-4" aria-hidden />
        {/* Below 1024px a tab shows only its icon, so the bar fits the 800px window (PAR-LOOK-04). */}
        <span className="hidden lg:inline">{label}</span>
      </button>
    );
  };
  const iconAction = (label: string, Icon: typeof House, onClick: () => void, testId: string, extra?: { disabled?: boolean; active?: boolean }) => (
    <Button
      variant="ghost"
      size="icon"
      className={`${desktopTopNavIconActionClassName} ${extra?.active ? "bg-[#161b22] text-white" : ""}`}
      aria-label={label}
      title={label}
      disabled={extra?.disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon className="size-4" aria-hidden />
    </Button>
  );

  return (
    <div className="flex h-screen flex-col">
      <DesktopAppTopNav
        logoSrc="./icon.png"
        logoAlt=""
        title="Parrot"
        desktopLayout="balanced"
        desktopNav={
          <nav className="flex items-center gap-1">
            {tab("home", t("nav.home"), House, "home-tab")}
            {tab("library", t("library.title"), LibraryBig, "library-tab")}
            {tab("playlists", t("nav.playlists"), ListMusic, "playlists-tab")}
          </nav>
        }
        leadingActions={
          <>
            {iconAction(searchPaletteStrings("parrot", language).title, Search, () => setSearchOpen(true), "parrot-top-nav-search")}
            <BadgerIconButton
              label={t("addMusic.label")}
              icon={badgerTopBarIcons.add}
              onClick={() => {
                if (!importStatus?.running && importStatus?.phase !== "review") setAddOpen(true);
              }}
              testId="library-import"
            />
            {/* UX-JOBS-01: imports and how they went live in the Jobs panel, as in Badger, not in a strip. */}
            <ImportJobs t={t} language={language} onReview={reviewImport} />
          </>
        }
        notificationAction={
          <DesktopNotificationTray
            open={trayOpen}
            onOpenChange={(next) => {
              setTrayOpen(next);
              if (next) notifications.markAllRead();
            }}
            title={t("nav.notifications")}
            subtitle={t("notifications.subtitle")}
            emptyMessage={t("notifications.empty")}
            trigger={
              <Button variant="ghost" size="icon" className={desktopTopNavIconActionClassName} aria-label={t("nav.notifications")} title={t("nav.notifications")} data-testid="nav-notifications">
                <Bell className="size-4" aria-hidden />
                {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary" data-testid="nav-notifications-unread" />}
              </Button>
            }
          >
            {notificationList.length > 0 ? (
              <NotificationTrayContent
                notifications={notificationList}
                onRemove={notifications.remove}
                onClearAll={notifications.clearAll}
                labels={{
                  filterAll: t("notifications.filterAll"),
                  filterError: t("notifications.filterError"),
                  filterWarning: t("notifications.filterWarning"),
                  filterInfo: t("notifications.filterInfo"),
                  filterSuccess: t("notifications.filterSuccess"),
                  clearAll: t("notifications.clearAll"),
                  dismiss: t("notifications.dismiss"),
                }}
              />
            ) : null}
          </DesktopNotificationTray>
        }
        accountAction={iconAction(t("nav.settings"), Settings, () => go({ kind: "settings" }), "nav-settings", { active: route.kind === "settings" })}
        signOutAction={
          profileStore ? (
            <ParrotProfileMenu
              store={profileStore}
              language={language}
              signOutLabel={t("library.signOut")}
              onSignOut={() => void requestSignOut()}
              onAddProfile={() => openProfiles(true)}
              onManageProfiles={() => openProfiles(false)}
            />
          ) : null
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
        <FounderBanner language={language} status={founder.status} onDismiss={founder.dismiss} className="mb-6" />
        {loadError && <p className="text-sm text-destructive">{t("library.loadError", { error: loadError })}</p>}
        {content === "loading" && !loadError && route.kind !== "settings" && <LibraryLoading label={t("library.loading")} />}
        {/* UX-CRASH-01: a crashing screen blanks only itself; the top bar and player keep working, leaving clears it;
            "Try again" reads the library afresh first. */}
        <RenderBoundary name={`route:${route.kind}`} resetKey={route} onRetry={() => load(true)}>
          {() => page()}
        </RenderBoundary>
      </main>
      <AddMusic t={t} open={addOpen} onOpenChange={setAddOpen} onScanned={setImportStatus} />
      <Notifications />
      <WindowDropOverlay
        drop={drop}
        labels={{
          dropTitle: t("addMusic.dropTitle"),
          dropSubtitle: t("addMusic.dropSubtitle"),
          processingTitle: t("addMusic.dropReading"),
          processingSubtitle: t("addMusic.dropWait"),
        }}
      />
      <RenderBoundary name="player" className="m-2">
      <Player
        like={(track) => like(track)}
        t={t}
        userId={userId}
        queue={queue}
        onQueue={setQueue}
        onPlaying={setPlaying}
        startAt={startAt}
        onPosition={(track, ms) => saveHistory((current) => recordPosition(current, track, ms))}
        // The lyrics follow the exact time; elsewhere whole seconds are enough (Home's "Resume 1:18", PAR-HOME-01),
        // and the window redraws once a second rather than at every tick.
        onClock={route.kind === "nowPlaying" ? setClockMs : (ms) => setClockMs(ms - (ms % 1000))}
        seekRef={seekRef}
        toggleRef={toggleRef}
        coverFor={coverFor}
        coverFetching={albumCoverFetching}
        openTab={route.kind === "nowPlaying" && route.tab !== "about" ? route.tab : null}
        onOpen={(tabName) => {
          if (tabName === null && route.kind === "nowPlaying") back();
          else if (route.kind === "nowPlaying") setRoute({ kind: "nowPlaying", tab: tabName ?? "queue" });
          else open({ kind: "nowPlaying", tab: tabName ?? "queue" });
        }}
        onOpenArtist={nameLinks.onOpenArtist}
        onOpenAlbum={nameLinks.onOpenAlbum}
      />
      </RenderBoundary>
      {/* UX-SETUP-10 / UX-UPDATE-01: "Your profile" alone for a profile picked after setup that still owes it, and
          "New in this update" over the library for a profile from before the update. */}
      {profileStore ? (
        <RenderBoundary name="profile-setup" variant="overlay">
          <ParrotProfileSetupOverlays store={profileStore} language={language} t={t} />
        </RenderBoundary>
      ) : null}
      {/* PAR-TOUR-01/02: step 1 once per computer the first time Home shows after setup, steps 2 and 3 on the first
          import; Settings replays it (PAR-TOUR-04). The player needs no tip (PAR-TOUR-03). */}
      <DesktopTourHost
        app="parrot"
        language={language}
        ready={route.kind === "home" && library !== null}
        suppressed={window.parrot.firstTourOff}
        videoSrc={tourDropVideo}
        onPickFiles={() => pickAndScan("files")}
      />
      <StreamSlotPrompt language={language} closeLabel={t("close")} />
      {feedbackOpen && (
        <RenderBoundary name="feedback" variant="overlay">
          <Feedback t={t} onClose={() => setFeedbackOpen(false)} />
        </RenderBoundary>
      )}
      {planOpen && (
        <RenderBoundary name="plans" variant="overlay">
          <Plans t={t} language={language} onClose={() => setPlanOpen(false)} />
        </RenderBoundary>
      )}
      {pairOpen && <PairDevice language={language} onClose={() => setPairOpen(false)} />}
      {signOutKeyCheckDialog}
      <ParrotSearchPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        artists={artists}
        albums={albums}
        songs={() => tracks}
        playlists={playlists.map((playlist) => ({ id: playlist.id, name: playlistName(playlist) }))}
        language={language}
        onOpenArtist={(id) => open({ kind: "artist", id })}
        onOpenAlbum={(id) => open({ kind: "album", id })}
        onOpenPlaylist={(id) => open({ kind: "playlist", id })}
        addToQueue={{
          label: t("card.addToQueue"),
          onAdd: ({ id }) => {
            const song = tracks.find((track) => track.id === id);
            if (song) enqueue([song], "end");
          },
        }}
        renderCover={(albumId) => {
          const src = coverFor(albumId)?.coverUrl;
          return src ? <img src={src} alt="" className="size-full object-cover" /> : null;
        }}
      />
      {playlistEditor.dialogs}
      <ParrotConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t("manage.deleteTitle", { title: removing?.title ?? "" })}
        body={removing ? deleteBody(removing) : ""}
        confirmLabel={t("manage.delete")}
        cancelLabel={t("manage.cancel")}
        onConfirm={() => void confirmDelete()}
        testId="manage-delete-confirm"
      />
      <ParrotKeepChoiceDialog
        open={choosing !== null}
        title={t("kept.chooseTitle")}
        body={t("kept.chooseBody")}
        choices={(choosing?.choices ?? []).map((choice) => ({
          key: choice.key,
          label: choice.label,
          detail: t("kept.choiceDetail", { songs: countText(language, t, "song", choice.songs), size: formatLocalizedStorage(choice.bytes, language) }),
        }))}
        cancelLabel={t("kept.cancel")}
        onCancel={() => setChoosing(null)}
        onPick={(key) => {
          if (!choosing) return;
          setChoosing(null);
          void window.parrot.keep(choosing.kind, choosing.id, key).then(setKept);
        }}
      />
      {editing ? (
        <ParrotEditMetadataDialog
          open
          onOpenChange={(next) => !next && !editBusy && setEditing(null)}
          kind={editing.target.kind}
          initial={editing.fields}
          current={editing.current}
          coverUrl={editing.coverUrl}
          labels={{
            title: t(`manage.editTitle.${editing.target.kind}`),
            cancel: t("manage.cancel"),
            submit: t("manage.save"),
            changed: t("manage.changed"),
            field: {
              title: t("manage.field.title"),
              artist: t("manage.field.artist"),
              album: t("manage.field.album"),
              albumArtist: t("manage.field.albumArtist"),
              number: t("manage.field.number"),
              disc: t("manage.field.disc"),
              year: t("manage.field.year"),
              genre: t("manage.field.genre"),
              cover: t("manage.field.cover"),
            },
            coverHint: t("manage.coverHint"),
            coverPick: t("manage.coverPick"),
            coverFrame: t("import.cover.frame"),
            frame: coverFrameLabels(t),
          }}
          error={editError}
          busy={editBusy}
          suggest={editSuggest}
          suggestLabels={editSuggestLabels(t)}
          lyrics={editLyrics}
          lyricsLabels={editLyricsLabels(t)}
          onSubmit={(fields, cover) => void saveEdit(fields, cover)}
        />
      ) : null}
      {importScan && importStatus?.phase === "review" ? <ImportReview t={t} language={language} scan={importScan} suggest={editSuggest} onDone={() => setImportScan(null)} /> : null}
      <span className="hidden" data-testid="signed-in-user">
        {state.user?.email}
      </span>
    </div>
  );
}

function PlayAll({ t, disabled, onClick }: { t: Translate; disabled: boolean; onClick: () => void }) {
  return (
    <Button onClick={onClick} disabled={disabled} data-testid="library-play-all">
      <Play className="mr-2 h-4 w-4 fill-current" aria-hidden />
      {t("player.play")}
    </Button>
  );
}

function DeleteButton({ t, onClick }: { t: Translate; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick} data-testid="library-delete">
      <Trash2 className="mr-2 h-4 w-4" aria-hidden />
      {t("manage.delete")}
    </Button>
  );
}
