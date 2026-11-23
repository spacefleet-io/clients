/**
 * Parrot desktop's profiles (ACCT-PROF-01, ACCT-PROF-02, ACCT-PROF-05): the shared store (`@space/shared/profileStore`),
 * the shared manager and avatar menu (`@space/ui/profiles`), as in Badger and on Parrot's phone (REL-FAM-02). The
 * session token stays in main: the store's API calls go over IPC (`window.parrot.*Profile*`) and a refusal comes back
 * as its status and code, rethrown here as the `ApiError` the store maps (`profile_limit` at the plan's limit,
 * `last_profile` for the only one). Playback on this computer names the account's main profile (STOR-BW-11), so picking
 * a profile in the top bar's menu (UX-TOP-02) only changes which one is ticked; with no "Who's listening?" on this
 * computer, the main profile is the current one until another is picked.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@space/shared/api";
import { createProfileStore, type ProfileLibraryMoves, type ProfileStore } from "@space/shared/profileStore";
import { profilesTranslator } from "@space/shared/profileTexts";
import { ProfileMenu, ProfilesManager } from "@space/ui/profiles";
import type { ParrotBridge, ParrotLanguage, ParrotProfilesResult } from "../../shared/ipc";

/** What the profiles need from `window.parrot`: main's calls with the session token. */
export type ParrotProfilesBridge = Pick<ParrotBridge, "listProfiles" | "createProfile" | "updateProfile" | "deleteProfile">;

const log = (event: string, data: Record<string, unknown>) => console.info(`parrot.${event}`, JSON.stringify(data));

const answer = async <T,>(call: Promise<ParrotProfilesResult<T>>): Promise<T> => {
  const result = await call;
  if (result.ok) return result.value;
  if ("offline" in result) throw new TypeError("offline");
  throw new ApiError(result.status, { error: result.code });
};

/**
 * What a delete moves in Parrot's library: nothing, as on the phone (`parrotProfileMoves`): playlists and hearts are
 * the account's until they are per profile, and this computer keeps no history per profile.
 */
const parrotDesktopMoves: ProfileLibraryMoves = {
  ensureReady: async () => undefined,
  wipeProfileViewing: async () => undefined,
  promoteProfileToMain: async () => undefined,
  healMainPromotion: async () => undefined,
  listViewingProfileIds: async () => [],
};

/** The store over main's profile calls and the window's localStorage; tests pass their own bridge. */
export const createParrotDesktopProfileStore = (bridge: ParrotProfilesBridge): ProfileStore => {
  const store = createProfileStore({
    storage: {
      getItem: async (key) => window.localStorage.getItem(key),
      setItem: async (key, value) => window.localStorage.setItem(key, value),
      removeItem: async (key) => window.localStorage.removeItem(key),
    },
    // The token is main's; the store only needs one to be set (`startSession`).
    api: {
      list: () => answer(bridge.listProfiles()),
      create: (_token, body) => answer(bridge.createProfile(body)),
      update: (_token, id, body) => answer(bridge.updateProfile(id, body)),
      remove: (_token, id) => answer(bridge.deleteProfile(id)),
    },
    applyScope: (profileId) => log("profiles.scope", { profileId }),
    log,
  });
  store.attachLibrary(parrotDesktopMoves);
  return store;
};

/**
 * The signed-in window's one profile store, shared by the top bar's avatar menu and Settings ▸ Account ▸ Profiles, so
 * a change in one shows at once in the other. This computer never asks "Who's listening?": when the store would ask
 * (several profiles, none kept), the main profile becomes the current one. No bridge (a browser preview) → no store:
 * the token that asks for the profiles lives in main.
 */
export const useParrotDesktopProfileStore = (userId: string, bridge: ParrotProfilesBridge | null): ProfileStore | null => {
  const [store] = useState(() => (bridge ? createParrotDesktopProfileStore(bridge) : null));
  useEffect(() => {
    if (!store) return;
    void store.startSession({ userId, token: "main", askEveryStart: false });
  }, [store, userId]);
  useEffect(() => {
    if (!store) return;
    const settle = () => {
      const snapshot = store.getSnapshot();
      if (snapshot.status !== "ready" || !snapshot.needsChoice) return;
      const main = snapshot.profiles.find((profile) => profile.isMain) ?? snapshot.profiles[0];
      if (!main) return;
      log("profiles.desktop.main_current", { profileId: main.id, count: snapshot.profiles.length });
      void store.selectProfile(main.id);
    };
    settle();
    return store.subscribe(settle);
  }, [store]);
  return store;
};

/**
 * The top bar's avatar menu (UX-TOP-02): the current profile's avatar, every profile, then Add profile, Manage profiles
 * and Sign out. Always shown, even with one profile.
 */
export function ParrotProfileMenu({
  store,
  language,
  signOutLabel,
  onSignOut,
  onAddProfile,
  onManageProfiles,
}: {
  store: ProfileStore;
  language: ParrotLanguage;
  signOutLabel: string;
  onSignOut: () => void;
  onAddProfile: () => void;
  onManageProfiles: () => void;
}) {
  return (
    <ProfileMenu
      store={store}
      log={log}
      t={profilesTranslator(language, { listening: true })}
      signOutLabel={signOutLabel}
      onSignOut={onSignOut}
      onAddProfile={onAddProfile}
      onManageProfiles={onManageProfiles}
    />
  );
}

/**
 * Settings ▸ Account ▸ Profiles: the account's profiles with their avatars, added, edited (name and avatar, through
 * the shared chooser, ACCT-PROF-05) and deleted with the API's limits. `startWith: "add"` opens straight on a new
 * profile (the menu's "Add profile") and shows the list once it is saved or cancelled. Opening the page reads the
 * list again, so a profile added, renamed or deleted on another device or the website shows here; the plan dialog
 * opens over this page, so the list (and its limit) is read again when it closes.
 */
export function ProfilesSection({
  store,
  language,
  planOpen = false,
  startWith,
}: {
  store: ProfileStore;
  language: ParrotLanguage;
  planOpen?: boolean;
  startWith?: "add";
}) {
  useEffect(() => {
    void store.refresh();
  }, [store]);
  const planWasOpen = useRef(planOpen);
  useEffect(() => {
    if (planWasOpen.current && !planOpen) void store.refresh();
    planWasOpen.current = planOpen;
  }, [store, planOpen]);
  return (
    <section data-testid="settings-profiles" className="mt-6 space-y-2">
      <h3 className="text-sm font-semibold">{profilesTranslator(language)("profiles.settingsGroup")}</h3>
      <ProfilesManager
        store={store}
        deleteProfile={(profileId) => store.deleteProfile(profileId, parrotDesktopMoves)}
        log={log}
        t={profilesTranslator(language, { listening: true })}
        startWith={startWith}
      />
    </section>
  );
}
