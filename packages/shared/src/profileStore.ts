/**
 * Profiles on the phone, TV and desktop apps (ACCT-PROF-01, ACCT-PROF-02, ACCT-SQUAD-02, UX-PROF-01, UX-PROF-02).
 *
 * The API holds the account's profiles (`/profiles`); this store keeps the last list per account in the app's storage
 * (`sf_profiles:<userId>`; AsyncStorage on phone/TV, localStorage on desktop) so the apps start offline, decides when
 * "Who's watching?" is asked, and points the app's LibraryDb at the chosen profile's viewing state (`applyScope`).
 * Each app makes one instance with its own storage, API and library (`apps/badger/mobile/src/lib/profiles/profileStore.ts`,
 * `apps/badger/desktop/src/renderer/src/lib/profileStore.ts`).
 *
 * When to ask (`resolveStartChoice`):
 *  - one profile: never; it is used straight away (UX-PROF-01);
 *  - TV (and desktop): at every start of the app (UX-PROF-02), so nothing is remembered for the start;
 *  - phone: once, at sign-in; the chosen profile is remembered (`sf_active_profile:<userId>`) and reopened at every
 *    start until sign-out (`endProfileSession` forgets it) or an in-app switch.
 * A remembered or active profile deleted on another device makes the app ask again (or use the only one left).
 */
import { ApiError } from "./api";
import {
  MAX_PROFILES_FREE,
  PROFILE_ERRORS,
  canCreateProfile,
  canDeleteProfile,
  normalizeProfileName,
  orderProfiles,
  type ApiProfile,
  type ProfilesResponse,
} from "./profiles";
import { profileAvatarIdOf, type ProfileAvatarId } from "./profileAvatars";

export const PROFILES_CACHE_KEY = (userId: string) => `sf_profiles:${userId}`;
export const ACTIVE_PROFILE_KEY = (userId: string) => `sf_active_profile:${userId}`;

export type ProfileErrorCode = (typeof PROFILE_ERRORS)[keyof typeof PROFILE_ERRORS] | "offline" | "unknown";

/** A refused profile change, with the API's code (or `offline` when the API could not be reached). */
export class ProfileActionError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super(code);
  }
}

export type ProfilesSnapshot = {
  userId: string | null;
  /** Oldest first; `isMain` on the first. Empty until the first list arrives (or when offline with no saved list). */
  profiles: ApiProfile[];
  maxProfiles: number;
  /** The profile whose viewing state the app shows; null while "Who's watching?" is open. */
  activeId: string | null;
  /** "Who's watching?" must be answered before the app opens. */
  needsChoice: boolean;
  /** `loading`: first list of this account not known yet (nothing saved); `ready`: a list (saved or fresh) is known. */
  status: "idle" | "loading" | "ready";
  /** True when the last refresh failed and the list shown is the saved one. */
  stale: boolean;
};

const IDLE: ProfilesSnapshot = {
  userId: null,
  profiles: [],
  maxProfiles: MAX_PROFILES_FREE,
  activeId: null,
  needsChoice: false,
  status: "idle",
  stale: false,
};

/**
 * Which profile opens when the app starts (or the list changes under it). `askEveryStart` = TV/desktop (UX-PROF-02).
 * `rememberedId`: the phone's saved choice, or the profile active right now when the list is refreshed.
 */
export const resolveStartChoice = (input: {
  profiles: readonly ApiProfile[];
  rememberedId: string | null;
  askEveryStart: boolean;
}): { activeId: string | null; needsChoice: boolean; reason: string } => {
  if (input.profiles.length === 0) return { activeId: null, needsChoice: false, reason: "no_profiles" };
  if (input.profiles.length === 1) return { activeId: input.profiles[0]!.id, needsChoice: false, reason: "single" };
  const remembered = input.rememberedId ? input.profiles.find((p) => p.id === input.rememberedId) : undefined;
  if (input.askEveryStart) return { activeId: null, needsChoice: true, reason: "ask_every_start" };
  if (remembered) return { activeId: remembered.id, needsChoice: false, reason: "remembered" };
  return { activeId: null, needsChoice: true, reason: input.rememberedId ? "remembered_deleted" : "first_choice" };
};

/** After a refresh: keep the active profile while it exists; ask again when it was deleted elsewhere. */
export const reconcileActive = (
  profiles: readonly ApiProfile[],
  activeId: string | null,
  needsChoice: boolean,
): { activeId: string | null; needsChoice: boolean; reason: string } => {
  if (profiles.length === 0) return { activeId: null, needsChoice: false, reason: "no_profiles" };
  if (activeId && profiles.some((p) => p.id === activeId)) return { activeId, needsChoice: false, reason: "kept" };
  if (profiles.length === 1) return { activeId: profiles[0]!.id, needsChoice: false, reason: "single" };
  return { activeId: null, needsChoice: true, reason: needsChoice ? "still_choosing" : "active_deleted" };
};

/**
 * Every profile carries its avatar id (ACCT-PROF-05): a list saved, or answered by an API, from before the avatar pack
 * holds only the palette colour, which maps to the matching avatar (`profileAvatarIdOf`).
 */
const withAvatarId = (profile: ApiProfile): ApiProfile => ({ ...profile, avatarId: profileAvatarIdOf(profile) });

const parseCache = (raw: string | null): ProfilesResponse | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProfilesResponse;
    if (!Array.isArray(parsed.profiles) || typeof parsed.maxProfiles !== "number") return null;
    return { profiles: orderProfiles(parsed.profiles.map(withAvatarId)), maxProfiles: parsed.maxProfiles };
  } catch {
    return null;
  }
};

export type ProfileStoreDeps = {
  storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  api: {
    list: (token: string) => Promise<ProfilesResponse>;
    create: (token: string, body: { name: string; avatarId?: ProfileAvatarId }) => Promise<ProfilesResponse & { profile: ApiProfile }>;
    update: (token: string, id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => Promise<ProfilesResponse & { profile: ApiProfile }>;
    remove: (token: string, id: string) => Promise<ProfilesResponse>;
  };
  applyScope: (profile: ApiProfile | null) => void;
  /** Phone/TV: device-local "last played episode" hints follow deletions and main-profile changes (`reconcileResumeHints`). */
  reconcileResumeHints?: (mainId: string, profileIds: string[]) => Promise<void>;
  log: (event: string, data: Record<string, unknown>) => void;
};

/** What deleting a profile must do in the encrypted library (the device that deletes runs it; LibraryDb owns the SQL). */
export type ProfileLibraryMoves = {
  /** Throws unless the library is open and just synced with the server: a delete must never outrun its data move. */
  ensureReady: () => Promise<void>;
  wipeProfileViewing: (profileId: string) => Promise<void>;
  promoteProfileToMain: (profileId: string) => Promise<void>;
  /** Syncs, then finishes a main profile's move that never completed (`needsMainPromotion`); a no-op otherwise. */
  healMainPromotion: (mainId: string) => Promise<void>;
  /** Ids of the profiles that hold viewing data under their own `p:<id>:` prefix (`viewingProfileIds`). */
  listViewingProfileIds: () => Promise<string[]>;
};

const errorCode = (error: unknown): ProfileErrorCode => {
  if (error instanceof ApiError) {
    const code = error.payload?.error;
    const known = Object.values(PROFILE_ERRORS) as string[];
    return typeof code === "string" && known.includes(code) ? (code as ProfileErrorCode) : "unknown";
  }
  if (error instanceof TypeError) return "offline"; // fetch network failure
  return "unknown";
};

/** i18n key (`profiles.errors.*`, the same on every app) of a refused profile change. */
export const profileErrorKey = (code: ProfileErrorCode): string => {
  switch (code) {
    case PROFILE_ERRORS.limit:
      return "profiles.errors.limit";
    case PROFILE_ERRORS.last:
      return "profiles.errors.last";
    case PROFILE_ERRORS.invalid:
      return "profiles.errors.invalid";
    case PROFILE_ERRORS.notFound:
      return "profiles.errors.notFound";
    case "offline":
      return "profiles.errors.offline";
    default:
      return "profiles.errors.unknown";
  }
};

export const createProfileStore = (deps: ProfileStoreDeps) => {
  let snapshot: ProfilesSnapshot = IDLE;
  let token: string | null = null;
  let askEveryStart = false;
  let sessionNonce = 0;
  /** The open library (`attachLibrary`), asked to finish an interrupted main-profile move after every fresh list. */
  let library: ProfileLibraryMoves | null = null;
  /** Main profile of the last list the API returned this session (null until then, or offline). */
  let freshMainId: string | null = null;
  let healing: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  /**
   * ACCT-PROF-02 heal on an open library after a fresh list: finishes an interrupted main-profile move, then erases the
   * viewing data of every profile deleted elsewhere (the website). A profile id missing from the list is asked to the
   * API once more right before its wipe, so a profile another device created after our list is never erased.
   */
  const healMain = () => {
    const moves = library;
    const mainId = freshMainId;
    const liveIds = new Set(snapshot.profiles.map((p) => p.id));
    if (!moves || !mainId) return;
    healing = healing.then(async () => {
      try {
        await moves.healMainPromotion(mainId);
        const unknown = (await moves.listViewingProfileIds()).filter((id) => !liveIds.has(id));
        if (unknown.length === 0 || !token) return;
        const current = new Set((await deps.api.list(token)).profiles.map((p) => p.id));
        const gone = unknown.filter((id) => !current.has(id));
        deps.log("profiles.heal.deleted_elsewhere", { unknown: unknown.length, gone });
        for (const id of gone) await moves.wipeProfileViewing(id);
      } catch (error: unknown) {
        deps.log("profiles.heal.failed", { mainId, error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const emit = (next: ProfilesSnapshot) => {
    snapshot = next;
    const active = next.profiles.find((p) => p.id === next.activeId) ?? null;
    deps.applyScope(active);
    for (const listener of [...listeners]) listener();
  };

  const persistList = async (userId: string, list: ProfilesResponse) => {
    await deps.storage.setItem(PROFILES_CACHE_KEY(userId), JSON.stringify(list)).catch(() => undefined);
  };

  const remember = async (userId: string, activeId: string | null) => {
    // TV/desktop never reopen a profile on their own (UX-PROF-02); only the phone keeps its choice.
    if (askEveryStart) return;
    if (activeId) await deps.storage.setItem(ACTIVE_PROFILE_KEY(userId), activeId).catch(() => undefined);
    else await deps.storage.removeItem(ACTIVE_PROFILE_KEY(userId)).catch(() => undefined);
  };

  /** Applies a fresh list from the API and keeps or drops the active profile. */
  const applyList = async (userId: string, list: ProfilesResponse, reasonPrefix: string) => {
    const profiles = orderProfiles(list.profiles.map(withAvatarId));
    const mainId = profiles[0]?.id ?? null;
    // Before the scope changes: a promoted main profile reads its own hints from its first render.
    if (mainId && deps.reconcileResumeHints) {
      await deps
        .reconcileResumeHints(
          mainId,
          profiles.map((p) => p.id)
        )
        .catch((error: unknown) => deps.log("profiles.resume_hints.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
    const decision = reconcileActive(profiles, snapshot.activeId, snapshot.needsChoice);
    deps.log("profiles.list.applied", {
      via: reasonPrefix,
      count: profiles.length,
      maxProfiles: list.maxProfiles,
      mainId,
      activeId: decision.activeId,
      needsChoice: decision.needsChoice,
      reason: decision.reason,
    });
    emit({
      ...snapshot,
      userId,
      profiles,
      maxProfiles: list.maxProfiles,
      activeId: decision.activeId,
      needsChoice: decision.needsChoice,
      status: "ready",
      stale: false,
    });
    await persistList(userId, { profiles, maxProfiles: list.maxProfiles });
    if (decision.activeId !== null || decision.needsChoice) await remember(userId, decision.activeId);
    freshMainId = mainId;
    healMain();
  };

  const requireSession = () => {
    if (!token || !snapshot.userId) throw new ProfileActionError("unknown");
    return { token, userId: snapshot.userId };
  };

  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The library opened (or closed: null). An open library finishes an interrupted main-profile move (ACCT-PROF-02). */
    attachLibrary(moves: ProfileLibraryMoves | null) {
      library = moves;
      deps.log("profiles.library.attached", { attached: moves !== null, freshMainId });
      healMain();
    },

    /** Signed in (or app started signed in): saved list first, then the API's. */
    async startSession(input: { userId: string; token: string; askEveryStart: boolean }) {
      const nonce = ++sessionNonce;
      token = input.token;
      askEveryStart = input.askEveryStart;
      const [cachedRaw, rememberedId] = await Promise.all([
        deps.storage.getItem(PROFILES_CACHE_KEY(input.userId)).catch(() => null),
        input.askEveryStart ? Promise.resolve(null) : deps.storage.getItem(ACTIVE_PROFILE_KEY(input.userId)).catch(() => null),
      ]);
      if (nonce !== sessionNonce) return;
      const cached = parseCache(cachedRaw);
      const start = resolveStartChoice({ profiles: cached?.profiles ?? [], rememberedId, askEveryStart: input.askEveryStart });
      deps.log("profiles.start", {
        userId: input.userId,
        askEveryStart: input.askEveryStart,
        cachedCount: cached?.profiles.length ?? null,
        remembered: Boolean(rememberedId),
        activeId: start.activeId,
        needsChoice: start.needsChoice,
        reason: start.reason,
      });
      emit({
        userId: input.userId,
        profiles: cached?.profiles ?? [],
        maxProfiles: cached?.maxProfiles ?? MAX_PROFILES_FREE,
        activeId: start.activeId,
        needsChoice: start.needsChoice,
        status: cached ? "ready" : "loading",
        stale: false,
      });
      await store.refresh(nonce, rememberedId);
    },

    /** Re-reads the list (start, foreground, opening the picker). Offline keeps the saved list. */
    async refresh(nonce = sessionNonce, rememberedId: string | null = null) {
      const session = token && snapshot.userId ? { token, userId: snapshot.userId } : null;
      if (!session) return;
      try {
        const list = await deps.api.list(session.token);
        if (nonce !== sessionNonce) return;
        if (snapshot.status === "loading") {
          // First list ever on this device: decide the start now that the profiles are known.
          const profiles = orderProfiles(list.profiles);
          const start = resolveStartChoice({ profiles, rememberedId, askEveryStart });
          deps.log("profiles.start.fresh", { count: profiles.length, activeId: start.activeId, needsChoice: start.needsChoice, reason: start.reason });
          snapshot = { ...snapshot, activeId: start.activeId, needsChoice: start.needsChoice };
        }
        await applyList(session.userId, list, "refresh");
      } catch (error) {
        if (nonce !== sessionNonce) return;
        const code = errorCode(error);
        deps.log("profiles.refresh.failed", { code, status: error instanceof ApiError ? error.status : null });
        // Offline with nothing saved: the library's own (main profile) state is used until the list arrives.
        emit({ ...snapshot, status: "ready", stale: true });
      }
    },

    /** "Who's watching?" answered, or a switch from inside the app (UX-PROF-01: one step, no new sign-in). */
    async selectProfile(profileId: string) {
      const profile = snapshot.profiles.find((p) => p.id === profileId);
      if (!profile || !snapshot.userId) {
        deps.log("profiles.select.unknown", { profileId });
        return;
      }
      deps.log("profiles.select", { profileId, isMain: profile.isMain, from: snapshot.activeId });
      emit({ ...snapshot, activeId: profileId, needsChoice: false });
      await remember(snapshot.userId, profileId);
    },

    /** Opens "Who's watching?" again (TV: switch profile). */
    askAgain() {
      deps.log("profiles.ask_again", { from: snapshot.activeId, count: snapshot.profiles.length });
      if (snapshot.profiles.length < 2) return;
      emit({ ...snapshot, activeId: null, needsChoice: true });
    },

    canCreate: () => canCreateProfile(snapshot.profiles.length, snapshot.maxProfiles),

    /** A new profile named `rawName`; without `avatarId` the API gives the first avatar no profile uses yet. */
    async createProfile(rawName: string, avatarId?: ProfileAvatarId) {
      const session = requireSession();
      const name = normalizeProfileName(rawName);
      if (!name) throw new ProfileActionError(PROFILE_ERRORS.invalid);
      if (!store.canCreate()) {
        deps.log("profiles.create.refused_local", { count: snapshot.profiles.length, maxProfiles: snapshot.maxProfiles });
        throw new ProfileActionError(PROFILE_ERRORS.limit);
      }
      try {
        const result = await deps.api.create(session.token, avatarId ? { name, avatarId } : { name });
        deps.log("profiles.create", { profileId: result.profile.id, count: result.profiles.length, avatarId: avatarId ?? null });
        await applyList(session.userId, result, "create");
        return withAvatarId(result.profile);
      } catch (error) {
        if (error instanceof ProfileActionError) throw error;
        const code = errorCode(error);
        deps.log("profiles.create.failed", { code });
        if (code === PROFILE_ERRORS.limit) await store.refresh();
        throw new ProfileActionError(code);
      }
    },

    /** Renames a profile and/or changes its avatar (ACCT-PROF-05); at least one of the two. */
    async editProfile(profileId: string, change: { name?: string; avatarId?: ProfileAvatarId }) {
      const session = requireSession();
      const body: { name?: string; avatarId?: ProfileAvatarId } = {};
      if (change.name !== undefined) {
        const name = normalizeProfileName(change.name);
        if (!name) throw new ProfileActionError(PROFILE_ERRORS.invalid);
        body.name = name;
      }
      if (change.avatarId !== undefined) body.avatarId = change.avatarId;
      if (body.name === undefined && body.avatarId === undefined) throw new ProfileActionError(PROFILE_ERRORS.invalid);
      try {
        const result = await deps.api.update(session.token, profileId, body);
        deps.log("profiles.edit", { profileId, fields: Object.keys(body), avatarId: body.avatarId ?? null });
        await applyList(session.userId, result, "edit");
        return withAvatarId(result.profile);
      } catch (error) {
        const code = errorCode(error);
        deps.log("profiles.edit.failed", { profileId, code });
        throw new ProfileActionError(code);
      }
    },

    /**
     * ACCT-PROF-02: any profile goes while another remains. The API deletes it first (it is the list every device
     * follows), then this device moves the library data: a non-main profile's `p:<id>:` keys are blanked; when the main
     * profile goes, the oldest remaining one becomes main and its state moves into the library's own storage.
     */
    async deleteProfile(profileId: string, moves: ProfileLibraryMoves) {
      const session = requireSession();
      const target = snapshot.profiles.find((p) => p.id === profileId);
      if (!canDeleteProfile(snapshot.profiles.length)) {
        deps.log("profiles.delete.refused_local", { profileId, count: snapshot.profiles.length });
        throw new ProfileActionError(PROFILE_ERRORS.last);
      }
      let result: ProfilesResponse;
      try {
        // The data move runs after the API delete: a library that cannot run it right now must stop the delete first.
        await moves.ensureReady();
      } catch (error) {
        deps.log("profiles.delete.library_not_ready", { profileId, error: error instanceof Error ? error.message : String(error) });
        throw new ProfileActionError("offline");
      }
      try {
        result = await deps.api.remove(session.token, profileId);
      } catch (error) {
        const code = errorCode(error);
        deps.log("profiles.delete.failed", { profileId, code });
        throw new ProfileActionError(code);
      }
      const remaining = orderProfiles(result.profiles);
      const newMain = remaining[0] ?? null;
      // Main by the server's list, not the local one (which may be stale): the target was main when no remaining
      // profile is older (`orderProfiles` order: createdAt, then id). Unknown locally = created after this list = never main.
      const wasMain = target
        ? !newMain || (target.createdAt.localeCompare(newMain.createdAt) || target.id.localeCompare(newMain.id)) < 0
        : false;
      deps.log("profiles.delete", {
        profileId,
        wasMain,
        wasMainLocally: target?.isMain ?? null,
        newMainId: newMain?.id ?? null,
        remaining: remaining.length,
      });
      if (wasMain && newMain) {
        // The new main profile stays scoped to its `p:` keys until the move is done; `applyList` below then points it
        // at the library's own storage, where its state now is.
        await moves.promoteProfileToMain(newMain.id);
        deps.log("profiles.delete.promoted", { newMainId: newMain.id, activeId: snapshot.activeId });
      } else {
        await moves.wipeProfileViewing(profileId);
        deps.log("profiles.delete.wiped", { profileId });
      }
      await applyList(session.userId, { profiles: remaining, maxProfiles: result.maxProfiles }, "delete");
    },

    /** Signed out: forget the phone's choice so the next sign-in asks (UX-PROF-01), and read the library's own state. */
    async endSession(userId: string | null) {
      sessionNonce += 1;
      freshMainId = null;
      deps.log("profiles.end", { userId });
      token = null;
      emit(IDLE);
      if (userId) {
        await Promise.all([
          deps.storage.removeItem(ACTIVE_PROFILE_KEY(userId)).catch(() => undefined),
          deps.storage.removeItem(PROFILES_CACHE_KEY(userId)).catch(() => undefined),
        ]);
      }
    },
  };
  return store;
};

/** One app's profile store: the list, the active profile and the changes (`createProfileStore`). */
export type ProfileStore = ReturnType<typeof createProfileStore>;
