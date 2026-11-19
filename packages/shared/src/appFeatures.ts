/**
 * App features a profile sets up once (UX-SETUP-10, UX-UPDATE-01): each one has a date (`since`). A profile created
 * on or after that date gets the feature's setup step; a profile created before it gets the "New in this update"
 * window instead. Either way the choice is kept on the profile (`ApiProfile.features`, server-side), so each
 * profile sees the step or the window once, on the first app that opens it, and never again on any device.
 */

export type AppFeatureId = "avatars";
/** `set`: the profile went through the feature's screen. `later`: the update window was dismissed. */
export type AppFeatureState = "set" | "later";
export type ProfileFeatures = Partial<Record<AppFeatureId, AppFeatureState>>;

export const APP_FEATURES: readonly { id: AppFeatureId; since: string }[] = [{ id: "avatars", since: "2026-11-19T00:00:00.000Z" }];

export const APP_FEATURE_IDS: readonly AppFeatureId[] = APP_FEATURES.map((feature) => feature.id);
export const APP_FEATURE_STATES = ["set", "later"] as const satisfies readonly AppFeatureState[];

export const isAppFeatureId = (value: unknown): value is AppFeatureId =>
  typeof value === "string" && (APP_FEATURE_IDS as readonly string[]).includes(value);

export const isAppFeatureState = (value: unknown): value is AppFeatureState =>
  typeof value === "string" && (APP_FEATURE_STATES as readonly string[]).includes(value);

type FeatureProfile = { createdAt: string; features?: ProfileFeatures };

const pending = (profile: FeatureProfile, createdSince: boolean): AppFeatureId[] => {
  const created = Date.parse(profile.createdAt);
  return APP_FEATURES.filter(
    (feature) => profile.features?.[feature.id] === undefined && created >= Date.parse(feature.since) === createdSince
  ).map((feature) => feature.id);
};

/** Features whose setup step this profile still needs: profile.createdAt >= since and features[id] unset. */
export const pendingSetupFeatures = (profile: FeatureProfile): AppFeatureId[] => pending(profile, true);

/** Features whose update window this profile should see: profile.createdAt < since and features[id] unset. */
export const pendingUpdateFeatures = (profile: FeatureProfile): AppFeatureId[] => pending(profile, false);
