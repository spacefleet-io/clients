/**
 * "Your profile" (UX-SETUP-10) and "New in this update" (UX-UPDATE-01) for Badger's phone and TV and Parrot's phone.
 * The answers live on the server, per profile (`ApiProfile.features`, `@space/shared/appFeatures`): the step shows for
 * a profile made since a feature arrived that never set it up (`pendingSetupFeatures`), the window for an older profile
 * that never answered it (`pendingUpdateFeatures`). The app binds its profile store once (`bindProfileSetup`); the
 * screens then save through `saveProfileSetup` and `laterUpdateFeature`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { pendingSetupFeatures, pendingUpdateFeatures, type AppFeatureId } from "@space/shared/appFeatures";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile } from "@space/shared/profiles";
import type { ProfilesSnapshot, ProfileStore } from "@space/shared/profileStore";

type Log = (event: string, data: Record<string, unknown>) => void;

let bound: { store: ProfileStore; log: Log } | null = null;

/** The app's profile store and log line, bound once at module load (Badger `profileStore.ts`, Parrot `profiles.ts`). */
export const bindProfileSetup = (input: { store: ProfileStore; log: Log }): void => {
  bound = input;
};

const requireBound = () => {
  if (!bound) throw new Error("profile-setup: bindProfileSetup was not called");
  return bound;
};

/** What a "New in this update" window says and shows for one feature (UX-UPDATE-01). Avatars first. */
export type UpdateFeature = { titleKey: string; textKey: string; ctaKey: string; art: readonly ProfileAvatarId[] };

export const UPDATE_FEATURES: Record<AppFeatureId, UpdateFeature> = {
  avatars: {
    titleKey: "profiles.whatsNew.avatars.title",
    // `{{name}}` is the profile's name, drawn in bold.
    textKey: "profiles.whatsNew.avatars.text",
    ctaKey: "profiles.whatsNew.avatars.cta",
    art: ["fox", "owl", "panda", "rocket", "octopus"],
  },
};

/**
 * The step's Next (UX-SETUP-10): one PATCH with the name, the avatar and `features.avatars = "set"`, sent even when
 * nothing changed so the step is never asked again on any device. Throws `ProfileActionError` (shown with
 * `profileErrorKey`).
 */
export const saveProfileSetup = async (profile: ApiProfile, change: { name: string; avatarId: ProfileAvatarId }): Promise<void> => {
  const { store, log } = requireBound();
  log("profile_setup.save", { profileId: profile.id, avatarId: change.avatarId, renamed: change.name.trim() !== profile.name });
  await store.editProfile(profile.id, { name: change.name, avatarId: change.avatarId, features: { avatars: "set" } });
  log("profile_setup.saved", { profileId: profile.id });
};

/**
 * Windows closed with "Later" on this device whose answer did not reach the server yet (offline): they stay closed
 * until the app restarts, when the window asks again.
 */
const laterHere = new Set<string>();
const laterKey = (profileId: string, feature: AppFeatureId) => `${profileId}:${feature}`;

/** "Later" (UX-UPDATE-01): records `features[id] = "later"`, so that profile never sees the window again anywhere. */
export const laterUpdateFeature = async (profile: ApiProfile, feature: AppFeatureId): Promise<void> => {
  const { store, log } = requireBound();
  laterHere.add(laterKey(profile.id, feature));
  log("whats_new.later", { profileId: profile.id, feature });
  try {
    await store.editProfile(profile.id, { features: { [feature]: "later" } });
    log("whats_new.later.saved", { profileId: profile.id, feature });
  } catch (error) {
    // Closed for this run anyway: a window that cannot record "Later" must not hold the app.
    log("whats_new.later.failed", { profileId: profile.id, feature, error: String(error) });
  }
};

/**
 * True when the profile picked has the setup step pending; null while no profile is picked yet. The phone setup counts
 * the step while this is not false (`askProfileSetupInSetup`), as for the title question.
 */
export const activeProfileNeedsSetup = (snapshot: Pick<ProfilesSnapshot, "profiles" | "activeId">): boolean | null => {
  const profile = snapshot.profiles.find(({ id }) => id === snapshot.activeId);
  if (!profile) return null;
  return pendingSetupFeatures(profile).length > 0;
};

/** The windows `profile` still has to see on this run, oldest feature first. */
export const updateFeatureQueue = (profile: ApiProfile | null): AppFeatureId[] =>
  profile ? pendingUpdateFeatures(profile).filter((feature) => !laterHere.has(laterKey(profile.id, feature))) : [];

export type UpdateFeatures = {
  /** The pending windows, one after another. */
  queue: AppFeatureId[];
  /** The window to show now. */
  current: AppFeatureId | null;
  /** The feature whose setup screen is open (opened from the window's main button). */
  settingUp: AppFeatureId | null;
  setUp: (feature: AppFeatureId) => void;
  /** From the setup screen back to its window. */
  back: () => void;
  later: (feature: AppFeatureId) => Promise<void>;
};

/**
 * The "New in this update" windows of the profile picked (UX-UPDATE-01): `current` is the one to show, `setUp` opens
 * the feature's setup screen (it leaves the queue once its answer is saved), `later` closes it for good.
 */
export const useUpdateFeatures = (profile: ApiProfile | null): UpdateFeatures => {
  // Re-read the queue after a "Later" that only closed the window here (the server's answer re-renders on its own).
  const [revision, setRevision] = useState(0);
  const [settingUp, setSettingUp] = useState<AppFeatureId | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` re-reads `laterHere`.
  const queue = useMemo(() => updateFeatureQueue(profile), [profile, revision]);
  const profileId = profile?.id ?? null;

  useEffect(() => {
    setSettingUp(null);
  }, [profileId]);
  useEffect(() => {
    if (settingUp && !queue.includes(settingUp)) setSettingUp(null);
  }, [queue, settingUp]);

  const setUp = useCallback(
    (feature: AppFeatureId) => {
      bound?.log("whats_new.set_up", { profileId, feature });
      setSettingUp(feature);
    },
    [profileId],
  );
  const back = useCallback(() => {
    bound?.log("whats_new.set_up.back", { profileId });
    setSettingUp(null);
  }, [profileId]);
  const later = useCallback(
    async (feature: AppFeatureId) => {
      if (!profile) return;
      const done = laterUpdateFeature(profile, feature);
      setRevision((value) => value + 1);
      await done;
    },
    [profile],
  );

  return { queue, current: settingUp ? null : (queue[0] ?? null), settingUp: settingUp && queue.includes(settingUp) ? settingUp : null, setUp, back, later };
};
