// The signed-in state every screen reads: the session, the library key, and the open library.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import type { ShellAuthSession } from "@space/mobile-shell/services/auth";
import type { AccountAccess } from "@space/shared/accountAccess";
import { getLibraryMeta, getMe, logout, type User } from "@space/shared/api";
import { decryptBase64ToBytes } from "@space/mobile-shell/libraryEnvelope";
import {
  checkKeptLibraryKey,
  keptLibraryKeyIsStale,
  watchKeptLibraryKey,
  type KeptLibraryKeyVerdict,
} from "@space/mobile-shell/kept-library-key";
import { keptKeyOwnerStore, libraryKeyStore, sessionStore, setupStore } from "../lib/stores";
import { autoFetchAlbumCovers, autoFetchArtistPictures, autoFetchLyrics, autoRefreshCopyChanges, lyricsPending, onLibraryChanged, openLibrary, openLibraryCopy, queueAutoLyrics, removeLibrary, saveLibraryEdits } from "../lib/library";
import { albumCoversWaiting, artistPicturesWaiting } from "../lib/picturesWaiting";
import { aboveTicketFloor, lookupClient, startLookup, stopLookup } from "../lib/lookup";
import { clearKeeping, keptLibraryLoaded, startKeeping } from "../lib/kept";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { ParrotPlaylistEdit } from "@space/parrot-core";
import { libraryOpenOutcome } from "../lib/libraryOpen";
import { keepsKeyOnSignIn, keyAfterSignedOut, type SignedOutReason } from "@space/shared/keptLibraryKey";
import { stopPlayback } from "../lib/playback";
import { loadEvenVolume } from "../lib/evenVolume";
import { scopeLogger } from "@space/mobile-shell/logger";
import { profileStore } from "../lib/profiles";
import { applyAccountLanguage, reconcileAfterSignIn, setupSettlesLanguage } from "../lib/accountLanguage";
import { publishSiblingStatus } from "@space/mobile-shell/sibling";

const log = scopeLogger("session");

/** The first setup still has the sign-in's language to settle (UX-SETUP-08): it asks, not the session. */
const languageLeftToSetup = async (): Promise<boolean> => {
  try {
    return setupSettlesLanguage(await setupStore.read());
  } catch {
    return false;
  }
};

type LibraryStatus = "idle" | "loading" | "ready" | "missing" | "error";

/** Why the sign-in screen is showing again: the server rejected the saved session (it shows a short explanation). */
export type SignInNotice = "sessionRejected" | null;

export type SessionState = {
  booting: boolean;
  session: ShellAuthSession | null;
  libraryKey: string | null;
  library: { status: LibraryStatus; error: string | null; version: number };
  /**
   * The signed-in account's access from its last `/auth/me` read (ACCT-UNPAID-03): an unpaid account shows the shared
   * notice with its wipe date. `null` while signed out or before the first answer.
   */
  access: AccountAccess | null;
  /**
   * Counts changes written into the open library before the server has them, or undone after a failed save
   * (PAR-PL-03): the playlist screens read it again on each, so a change shows at once.
   */
  localChanges: number;
  signInNotice: SignInNotice;
  signIn: (session: ShellAuthSession) => Promise<void>;
  saveLibraryKey: (key: string) => Promise<void>;
  reloadLibrary: () => Promise<void>;
  /**
   * Saves playlist and heart edits into the library (PAR-PL-02/03/04); the screens re-read it once saved. Rejects when
   * the save failed (the server's library is open again): the caller undoes its change and says so.
   */
  saveEdits: (edits: readonly ParrotPlaylistEdit[]) => Promise<void>;
  /**
   * Runs a library change that publishes a new version (an edit, a delete: PAR-META-16, PAR-LIB-03); the screens re-read
   * the library once it is saved. Rejects as `saveEdits` does.
   */
  changeLibrary: (label: string, change: () => Promise<number>) => Promise<void>;
  /**
   * PAR-COPY-01: a song shown that was never looked up goes first in the automatic lyrics pass (a screen never looks it
   * up itself); it is "Looking for lyrics…" until the pass kept its answer in the library.
   */
  wantLyrics: (trackId: string) => void;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export const useSession = () => {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
};

/** The signed-in values a screen behind the gates can rely on. */
export const useSignedIn = () => {
  const { session, libraryKey } = useSession();
  if (!session || !libraryKey) throw new Error("not signed in");
  return { token: session.token, libraryKey };
};

export const SessionProvider = ({ children }: { children: React.ReactNode }) => {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<ShellAuthSession | null>(null);
  const [libraryKey, setLibraryKey] = useState<string | null>(null);
  const [library, setLibrary] = useState<SessionState["library"]>({ status: "idle", error: null, version: 0 });
  const [signInNotice, setSignInNotice] = useState<SignInNotice>(null);
  const [access, setAccess] = useState<AccountAccess | null>(null);
  const [localChanges, setLocalChanges] = useState(0);
  useEffect(() => onLibraryChanged(() => setLocalChanges((count) => count + 1)), []);

  // The automatic lyrics lookup (PAR-LYR-01): one pass at a time, run again when the library opens during one; the songs
  // that next pass will ask are pending from then on (PAR-LYR-06).
  const autoLyrics = useRef<{ stop: AbortController; again: boolean } | null>(null);
  const startAutoLyrics = useCallback(() => {
    if (autoLyrics.current) {
      autoLyrics.current.again = true;
      void queueAutoLyrics().catch((error: unknown) => log.warn("lyrics.auto_queue_failed", { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const run = { stop: new AbortController(), again: false };
    autoLyrics.current = run;
    autoFetchLyrics({
      lookup: async (question) => (await lookupClient()).musicLyrics(question),
      signal: run.stop.signal,
      canSpend: aboveTicketFloor,
      saved: (version) => {
        if (!run.stop.signal.aborted) setLibrary({ status: "ready", error: null, version });
      },
    })
      .then(
        (report) => log.info("lyrics.auto", report),
        (error: unknown) => log.warn("lyrics.auto_failed", { message: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        if (autoLyrics.current !== run) return;
        autoLyrics.current = null;
        if ((run.again || lyricsPending.hasWanted()) && !run.stop.signal.aborted) startAutoLyrics();
      });
  }, []);
  const wantLyrics = useCallback(
    (trackId: string) => {
      lyricsPending.want(trackId);
      if (!autoLyrics.current) startAutoLyrics();
    },
    [startAutoLyrics]
  );
  const stopAutoLyrics = () => {
    autoLyrics.current?.stop.abort();
    autoLyrics.current = null;
    lyricsPending.clear();
  };

  // The automatic artist-photo lookup (PAR-META-15): one pass at a time, run again when the library opens during one.
  const autoPictures = useRef<{ stop: AbortController; again: boolean } | null>(null);
  const startAutoPictures = useCallback(() => {
    if (autoPictures.current) {
      autoPictures.current.again = true;
      return;
    }
    const run = { stop: new AbortController(), again: false };
    autoPictures.current = run;
    autoFetchArtistPictures({
      lookup: async (artistId) => (await lookupClient()).musicArtistImage(artistId),
      // PAR-META-15: an artist without an id gets the one of its matched album or song first.
      albums: async (question) => (await lookupClient()).musicAlbums(question),
      recordings: async (question) => (await lookupClient()).musicRecordings(question),
      signal: run.stop.signal,
      canSpend: aboveTicketFloor,
      saved: (version) => {
        if (!run.stop.signal.aborted) setLibrary({ status: "ready", error: null, version });
      },
      // PAR-META-20: the artists still to ask; their photos shimmer rather than look missing.
      onWaiting: (artistIds) => {
        if (!run.stop.signal.aborted) artistPicturesWaiting.set(artistIds);
      },
    })
      .then(
        (report) => log.info("artist_pictures.auto", report),
        (error: unknown) => log.warn("artist_pictures.auto_failed", { message: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        if (autoPictures.current !== run) return;
        autoPictures.current = null;
        artistPicturesWaiting.clear();
        if (run.again && !run.stop.signal.aborted) startAutoPictures();
      });
  }, []);
  const stopAutoPictures = () => {
    autoPictures.current?.stop.abort();
    autoPictures.current = null;
    artistPicturesWaiting.clear();
  };

  // The automatic album-cover lookup (PAR-META-20): one pass at a time, run again when the library opens during one.
  // The albums it still has to ask go to `albumCoversWaiting`, so their covers shimmer rather than look missing.
  const autoCovers = useRef<{ stop: AbortController; again: boolean } | null>(null);
  const startAutoCovers = useCallback(() => {
    if (autoCovers.current) {
      autoCovers.current.again = true;
      return;
    }
    const run = { stop: new AbortController(), again: false };
    autoCovers.current = run;
    autoFetchAlbumCovers({
      lookup: async (albumId, size) => (await lookupClient()).musicCover(albumId, size),
      signal: run.stop.signal,
      canSpend: aboveTicketFloor,
      saved: (version) => {
        if (!run.stop.signal.aborted) setLibrary({ status: "ready", error: null, version });
      },
      onWaiting: (albumIds) => {
        if (!run.stop.signal.aborted) albumCoversWaiting.set(albumIds);
      },
    })
      .then(
        (report) => log.info("album_covers.auto", report),
        (error: unknown) => log.warn("album_covers.auto_failed", { message: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        if (autoCovers.current !== run) return;
        autoCovers.current = null;
        albumCoversWaiting.clear();
        if (run.again && !run.stop.signal.aborted) startAutoCovers();
      });
  }, []);
  const stopAutoCovers = () => {
    autoCovers.current?.stop.abort();
    autoCovers.current = null;
    albumCoversWaiting.clear();
  };

  // The music-copy refresh (PAR-COPY-01): at most once a day, the held albums a new copy changed follow it.
  const copyChanges = useRef<AbortController | null>(null);
  const startCopyChanges = useCallback(() => {
    if (copyChanges.current) return;
    const stop = new AbortController();
    copyChanges.current = stop;
    autoRefreshCopyChanges({
      changes: async (since) => (await lookupClient()).musicCopyChanges(since),
      albums: async (question) => (await lookupClient()).musicAlbums(question),
      signal: stop.signal,
      canSpend: aboveTicketFloor,
      saved: (version) => {
        if (!stop.signal.aborted) setLibrary({ status: "ready", error: null, version });
      },
    })
      .then(
        (report) => log.info("copy_changes", report),
        (error: unknown) => log.warn("copy_changes.failed", { message: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        if (copyChanges.current === stop) copyChanges.current = null;
      });
  }, []);
  const stopCopyChanges = () => {
    copyChanges.current?.abort();
    copyChanges.current = null;
  };

  useEffect(() => {
    void (async () => {
      try {
        const [stored, key] = await Promise.all([sessionStore.read(), libraryKeyStore.get()]);
        setSession(stored);
        setLibraryKey(stored ? key : null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // Badger on this phone offers "Continue with your Parrot account" only while Parrot can sign it in (ACCT-PAIR-07): a
  // session and the library key it seals to Badger. The native status store gets the account, never the token or key.
  const siblingUserId = session && libraryKey ? session.user.id : null;
  const siblingEmail = session && libraryKey ? session.user.email : null;
  useEffect(() => {
    if (booting) return;
    void publishSiblingStatus(siblingUserId && siblingEmail ? { email: siblingEmail, userId: siblingUserId } : null);
  }, [booting, siblingUserId, siblingEmail]);

  /**
   * Forgets the session and the library on this phone; the API is told only when the token still works. The library
   * key goes too on a Sign out, but stays after a rejected session, remembered as that account's.
   */
  const clearLocal = useCallback(async (reason: SignedOutReason) => {
    await stopPlayback();
    stopAutoLyrics();
    stopAutoPictures();
    stopAutoCovers();
    stopCopyChanges();
    // The anonymous tickets go with the session (META-ANON-02).
    stopLookup();
    const keepKey = keyAfterSignedOut(reason) === "keep";
    const ownerId = session?.user.id ?? null;
    // The kept songs go before the library they belong to (PAR-OFFL-01): no account, nothing kept on this phone.
    await clearKeeping().catch((error: unknown) =>
      log.warn("kept.clear_failed", { message: error instanceof Error ? error.message : String(error) })
    );
    await Promise.all([
      sessionStore.write(null),
      removeLibrary(),
      keepKey
        ? ownerId
          ? keptKeyOwnerStore.write(ownerId)
          : Promise.resolve()
        : Promise.all([libraryKeyStore.clear(), keptKeyOwnerStore.forget()]),
    ]);
    // The next sign-in asks "Who's listening?" again (UX-PROF-01).
    await profileStore.endSession(ownerId);
    log.info("signed_out", { reason, keptKey: keepKey });
    setLibrary({ status: "idle", error: null, version: 0 });
    setLibraryKey(null);
    setSession(null);
  }, [session]);

  /**
   * The kept key is no longer the account's (UX-KEY-01, `@space/mobile-shell/kept-library-key`): erased account-wide
   * on another device (no probe), or erased and remade there (the probe does not open). The session stays; the key,
   * the library copy and the kept songs go, and the gate shows the key step, which asks for the account's key when it
   * has a probe and makes one when it has none.
   */
  const forgetLibraryKey = useCallback(async (verdict: KeptLibraryKeyVerdict) => {
    log.warn("kept_key.forgotten", { verdict });
    await stopPlayback();
    stopAutoLyrics();
    stopAutoPictures();
    stopAutoCovers();
    await clearKeeping().catch((error: unknown) =>
      log.warn("kept.clear_failed", { message: error instanceof Error ? error.message : String(error) })
    );
    await Promise.all([removeLibrary(), libraryKeyStore.clear(), keptKeyOwnerStore.forget()]);
    setLibrary({ status: "idle", error: null, version: 0 });
    setLibraryKey(null);
  }, []);

  const checkKey = useCallback(
    (token: string, key: string) =>
      checkKeptLibraryKey(key, {
        fetchMeta: () => getLibraryMeta(token, "parrot"),
        decrypt: decryptBase64ToBytes,
        log: (event, details) => log.info(event, details),
      }),
    []
  );

  const load = useCallback(
    async (token: string, key: string) => {
      setLibrary((prev) => ({ ...prev, status: "loading", error: null }));
      // Before the library opens (and anything publishes): a key the account no longer has goes. No connection keeps it.
      const verdict = await checkKey(token, key);
      if (keptLibraryKeyIsStale(verdict)) {
        await forgetLibraryKey(verdict);
        return;
      }
      const opened = (snapshotVersion: number) => {
        setLibrary({ status: "ready", error: null, version: snapshotVersion });
        void startKeeping(token)
          .then(keptLibraryLoaded)
          .catch((error: unknown) => log.warn("kept.start_failed", { message: error instanceof Error ? error.message : String(error) }));
      };
      try {
        opened((await openLibrary(token, key)).snapshotVersion);
        // The tickets are asked for once the library opens, never by a first lookup (META-ANON-02). Only the server's
        // library is looked up: the offline copy below has no connection to ask with.
        startLookup();
        startAutoLyrics();
        startAutoPictures();
        startAutoCovers();
        startCopyChanges();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = libraryOpenOutcome(error);
        log.warn("library.open_failed", { message, outcome });
        if (outcome === "sessionRejected") {
          // A Try again can never work with a token the server refused: back to sign-in, saying why.
          setSignInNotice("sessionRejected");
          await clearLocal("sessionRejected");
          return;
        }
        // No connection, but songs are kept on this phone: the library copy kept with them opens instead (PAR-OFFL-01).
        const copy = outcome === "error" ? await openLibraryCopy(token, key).catch(() => null) : null;
        if (copy) {
          log.info("library.opened_offline_copy", { version: copy.snapshotVersion });
          opened(copy.snapshotVersion);
          return;
        }
        setLibrary({ status: outcome === "missing" ? "missing" : "error", error: message, version: 0 });
      }
    },
    [checkKey, clearLocal, forgetLibraryKey, startAutoLyrics, startAutoPictures, startAutoCovers]
  );

  // The download notification follows the app's language: the engine gets its text again when it changes.
  const { i18n } = useTranslation();
  const ready = library.status === "ready";
  useEffect(() => {
    if (ready && session) void startKeeping(session.token).catch(() => undefined);
  }, [i18n.language, ready, session]);

  useEffect(() => {
    if (session && libraryKey) void load(session.token, libraryKey);
  }, [session, libraryKey, load]);

  // Back to the front: the library may have been erased, or its key remade, on another device meanwhile (UX-KEY-01).
  // The start check is in `load`; this one runs on each foreground only.
  useEffect(() => {
    if (!session || !libraryKey) return;
    const { token } = session;
    return watchKeptLibraryKey({
      check: () => checkKey(token, libraryKey),
      onStale: forgetLibraryKey,
      appState: AppState,
      atStart: false,
      log: (event, details) => log.info(event, details),
    });
  }, [session, libraryKey, checkKey, forgetLibraryKey]);

  // The account's profiles (ACCT-PROF-01): the phone keeps its pick, like Badger's phone (UX-PROF-01); the TV asks
  // "Who's listening?" at every start, like Badger TV (PAR-TV-02, UX-PROF-02). The list is read again each time the app
  // comes back to the front, so a profile added, renamed or deleted on another device shows here.
  useEffect(() => {
    if (session) void profileStore.startSession({ userId: session.user.id, token: session.token, askEveryStart: Platform.isTV });
  }, [session]);

  const profilesUserId = session?.user.id ?? null;
  useEffect(() => {
    if (!profilesUserId) return;
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void profileStore.refresh();
    });
    return () => subscription.remove();
  }, [profilesUserId]);

  // One `/auth/me` read at start, after a sign-in and each time the app comes back to the front brings:
  // - the account's access (ACCT-UNPAID-03): an unpaid account sees the shared notice with its wipe date above the main
  //   screens; signed out, or before the first answer, nothing is known and nothing shows;
  // - UX-I18N-07: the account's one language, so a change made on another device shows here. A fresh sign-in already
  //   reconciled it, and while the first setup still has to ask (UX-SETUP-08) it is not shown over the one picked there.
  const sessionToken = session?.token ?? null;
  const reconciledToken = useRef<string | null>(null);
  useEffect(() => {
    setAccess(null);
    if (!sessionToken) return;
    let live = true;
    const refresh = async (language: boolean) => {
      let user: User;
      try {
        user = (await getMe(sessionToken)).user;
      } catch (error) {
        log.warn("account.refresh_failed", { message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!live) return;
      setAccess(user.access ?? null);
      log.info("account.access", { state: user.access?.state ?? null });
      if (!language || (await languageLeftToSetup())) return;
      await applyAccountLanguage(user);
    };
    void refresh(reconciledToken.current !== sessionToken);
    reconciledToken.current = null;
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void refresh(true);
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [sessionToken]);

  // Even out volume (PAR-PLAY-03): kept on this phone per account; signed out it is off.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    void loadEvenVolume(userId);
  }, [userId]);

  const changeLibrary = useCallback(async (label: string, change: () => Promise<number>) => {
    try {
      const version = await change();
      setLibrary({ status: "ready", error: null, version });
      void keptLibraryLoaded().catch(() => undefined);
    } catch (error) {
      log.warn("library.save_failed", { label, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      booting,
      session,
      libraryKey,
      localChanges,
      library,
      access,
      signInNotice,
      signIn: async (next) => {
        await sessionStore.write(next);
        setSignInNotice(null);
        const keyOwnerId = await keptKeyOwnerStore.read();
        if (!keepsKeyOnSignIn({ keyOwnerId, signedInUserId: next.user.id })) {
          log.info("kept_key_dropped", { reason: "other_account" });
          await libraryKeyStore.clear();
        }
        await keptKeyOwnerStore.forget();
        // UX-I18N-07: before setup, the language picked before signing in meets the account's (asked when they differ);
        // during the first setup, the setup asks right after this sign-in (UX-SETUP-08, `SetupFlow`).
        if (await languageLeftToSetup()) log.info("account_language.left_to_setup");
        else await reconcileAfterSignIn(next.token);
        reconciledToken.current = next.token;
        setLibraryKey(await libraryKeyStore.get());
        setSession(next);
      },
      saveLibraryKey: async (key) => {
        await libraryKeyStore.set(key);
        await libraryKeyStore.acknowledge();
        setLibraryKey(key);
      },
      reloadLibrary: async () => {
        if (session && libraryKey) await load(session.token, libraryKey);
      },
      saveEdits: (edits) => changeLibrary("playlists", () => saveLibraryEdits(edits)),
      changeLibrary,
      wantLyrics,
      signOut: async () => {
        const token = session?.token;
        if (token) await logout(token).catch(() => undefined);
        setSignInNotice(null);
        await clearLocal("signOut");
      },
    }),
    [booting, session, libraryKey, library, access, localChanges, signInNotice, load, clearLocal, changeLibrary, wantLyrics]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};
