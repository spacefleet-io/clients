import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  MAX_PROFILES_FREE,
  MAX_PROFILES_PAID,
  PROFILE_ERRORS,
  canCreateProfile,
  canDeleteProfile,
  normalizeProfileName,
  type ApiProfile,
} from "@space/shared/profiles";
import { nextProfileAvatarId, profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import {
  ProfileActionError,
  profileErrorKey,
  type ProfileErrorCode,
  type ProfileLibraryMoves,
  type ProfileStore,
} from "@space/shared/profileStore";

/** The steps of "Who's watching?" / "Who's listening?" and the profile manager, shared by Badger's phone and TV and Parrot's phone. */
export type ProfilesMode =
  | { name: "pick" }
  | { name: "manage" }
  | { name: "edit"; profileId: string | null }
  | { name: "confirmDelete"; profileId: string }
  | { name: "busy" };

/**
 * `startMode`: "pick" for "Who's watching?", "manage" when opened from Settings. `onPicked` runs after a profile is
 * chosen (the in-app switch closes its screen; the start gate needs nothing, the navigator moves on by itself).
 * `log` receives every step (the TV prefixes `tv.profiles.` so the e2e harness reads them from logcat).
 */
export const useProfilesFlow = (options: {
  store: ProfileStore;
  /** The open library's data moves for a delete (ACCT-PROF-02). */
  moves: ProfileLibraryMoves;
  startMode: "pick" | "manage";
  onPicked?: (profile: ApiProfile) => void;
  log: (event: string, data: Record<string, unknown>) => void;
}) => {
  const { store: profileStore, moves: profileMoves, log, onPicked, startMode } = options;
  const snapshot = useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
  const startState = useMemo<ProfilesMode>(() => (startMode === "pick" ? { name: "pick" } : { name: "manage" }), [startMode]);
  const [mode, setModeState] = useState<ProfilesMode>(startState);
  const [draftName, setDraftName] = useState("");
  // The avatar picked in the add / edit step (ACCT-PROF-05).
  const [draftAvatarId, setDraftAvatarId] = useState<ProfileAvatarId>(() => nextProfileAvatarId([]));
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Opening the screen re-reads the list, so a profile added, renamed or deleted in another app shows (ACCT-PROF-01).
  useEffect(() => {
    void profileStore.refresh();
  }, [profileStore]);

  const setMode = useCallback(
    (next: ProfilesMode) => {
      log("mode", { mode: next.name, ...("profileId" in next ? { profileId: next.profileId } : {}) });
      setModeState(next);
    },
    [log],
  );

  const fail = useCallback(
    (error: unknown, back: ProfilesMode, step: string) => {
      const code: ProfileErrorCode = error instanceof ProfileActionError ? error.code : "unknown";
      log("failed", { step, code });
      setErrorKey(profileErrorKey(code));
      setMode(back);
    },
    [log, setMode],
  );

  const pick = useCallback(
    async (profile: ApiProfile) => {
      log("selected", { profileId: profile.id, index: snapshot.profiles.findIndex((p) => p.id === profile.id), isMain: profile.isMain });
      await profileStore.selectProfile(profile.id);
      onPicked?.(profile);
    },
    [log, onPicked, profileStore, snapshot.profiles],
  );

  const startAdd = useCallback(() => {
    setErrorKey(null);
    if (!canCreateProfile(snapshot.profiles.length, snapshot.maxProfiles)) {
      log("add.refused", { count: snapshot.profiles.length, maxProfiles: snapshot.maxProfiles });
      setErrorKey(profileErrorKey(PROFILE_ERRORS.limit));
      return;
    }
    // A new profile starts on the first avatar no profile of the account uses yet.
    const avatarId = nextProfileAvatarId(snapshot.profiles.map(profileAvatarIdOf));
    log("add.start", { avatarId });
    setDraftName("");
    setDraftAvatarId(avatarId);
    setMode({ name: "edit", profileId: null });
  }, [log, setMode, snapshot.maxProfiles, snapshot.profiles]);

  const startEdit = useCallback(
    (profile: ApiProfile) => {
      setErrorKey(null);
      setDraftName(profile.name);
      setDraftAvatarId(profileAvatarIdOf(profile));
      setMode({ name: "edit", profileId: profile.id });
    },
    [setMode],
  );

  const chooseAvatar = useCallback(
    (avatarId: ProfileAvatarId) => {
      log("avatar.chosen", { avatarId });
      setDraftAvatarId(avatarId);
    },
    [log],
  );

  const save = useCallback(async () => {
    if (mode.name !== "edit") return;
    if (!normalizeProfileName(draftName)) {
      setErrorKey(profileErrorKey(PROFILE_ERRORS.invalid));
      return;
    }
    const editing = mode;
    setErrorKey(null);
    setMode({ name: "busy" });
    try {
      if (editing.profileId) {
        await profileStore.editProfile(editing.profileId, { name: draftName, avatarId: draftAvatarId });
        log("edited", { profileId: editing.profileId, avatarId: draftAvatarId });
        setMode({ name: "manage" });
      } else {
        // The user picked the avatar here, so the profile never gets the avatars setup step or update window (UX-SETUP-10).
        const created = await profileStore.createProfile(draftName, draftAvatarId, { avatars: "set" });
        log("created", { profileId: created.id, avatarId: draftAvatarId, count: profileStore.getSnapshot().profiles.length });
        setMode(startState);
      }
    } catch (error) {
      fail(error, editing, editing.profileId ? "edit" : "create");
    }
  }, [draftAvatarId, draftName, fail, log, mode, profileStore, setMode, startState]);

  const askDelete = useCallback(
    (profile: ApiProfile) => {
      setErrorKey(null);
      if (!canDeleteProfile(snapshot.profiles.length)) {
        log("delete.refused", { profileId: profile.id });
        setErrorKey(profileErrorKey(PROFILE_ERRORS.last));
        return;
      }
      setMode({ name: "confirmDelete", profileId: profile.id });
    },
    [log, setMode, snapshot.profiles.length],
  );

  const confirmDelete = useCallback(async () => {
    if (mode.name !== "confirmDelete") return;
    const { profileId } = mode;
    setMode({ name: "busy" });
    try {
      await profileStore.deleteProfile(profileId, profileMoves);
      log("deleted", { profileId, remaining: profileStore.getSnapshot().profiles.length });
      setMode({ name: "manage" });
    } catch (error) {
      fail(error, { name: "manage" }, "delete");
    }
  }, [fail, log, mode, profileMoves, profileStore, setMode]);

  /**
   * Leaves the current step: a new profile's form goes back where it was opened from, edit/delete go back to
   * managing, managing goes back to "Who's watching?".
   */
  const cancel = useCallback(() => {
    setErrorKey(null);
    if (mode.name === "edit" && mode.profileId === null) setMode(startState);
    else if (mode.name === "manage") setMode({ name: "pick" });
    else setMode({ name: "manage" });
  }, [mode, setMode, startState]);

  const profileOf = (id: string | null) => snapshot.profiles.find((p) => p.id === id) ?? null;
  // Derived from the snapshot, never `profileStore.canCreate()`: the store object never changes, so the React Compiler
  // would keep the first answer and Add would not follow a profile added or deleted until the screen remounts.
  const canCreate = canCreateProfile(snapshot.profiles.length, snapshot.maxProfiles);
  /**
   * Why "Add profile" is unavailable once the account is full (ACCT-PROF-01), shown under the greyed button as the
   * shared `ProfilesManager` does: a free account says it has one and paid plans have more; a full paid account says it
   * has its `maxProfiles`.
   */
  const limitNote: { key: string; values: Record<string, number> } | null = canCreate
    ? null
    : snapshot.maxProfiles <= MAX_PROFILES_FREE
      ? { key: "profiles.limitFree", values: { paidMax: MAX_PROFILES_PAID } }
      : { key: "profiles.errors.limit", values: { max: snapshot.maxProfiles } };

  return {
    snapshot,
    mode,
    setMode,
    draftName,
    setDraftName,
    draftAvatarId,
    chooseAvatar,
    errorKey,
    profileOf,
    pick,
    startAdd,
    startEdit,
    save,
    askDelete,
    confirmDelete,
    cancel,
    canCreate,
    canDelete: canDeleteProfile(snapshot.profiles.length),
    limitNote,
  };
};
