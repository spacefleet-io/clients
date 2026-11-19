/**
 * UX-UPDATE-01: what each update brings that a profile can set up, and the "New in this update" windows that offer it.
 * A feature registers its window (title, text, art), the screen its button opens (the same screen as its setup step,
 * UX-SETUP-10) and when a profile counts as set up. Right after the profile is picked, a profile from before the
 * feature (`pendingUpdateFeatures` of `@space/shared/appFeatures`) sees one window per such feature, one after the
 * other, in registry order. "Later" saves `features.<id> = "later"` on the profile, so no app shows it again; the
 * feature's screen saves `"set"`. A profile made since the feature never sees the window: it has the setup step.
 */
import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { pendingSetupFeatures, pendingUpdateFeatures, type AppFeatureId } from "@space/shared/appFeatures";
import type { ApiProfile } from "@space/shared/profiles";
import type { ProfileStore } from "@space/shared/profileStore";
import type { ProfilesLog, ProfilesText } from "@space/ui/profiles";
import { AvatarRowArt, ProfileSetupStep, WhatsNewWindow, saveProfileSetup, withBoldName } from "./profile-setup";

/** What an app gives the setup screens it opens: its words, its mascot and where the screen is drawn. */
export type UpdateFeatureScreenProps = {
  profile: ApiProfile;
  store: ProfileStore;
  t: ProfilesText;
  backLabel: string;
  nextLabel: string;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
  log: ProfilesLog;
  /** Back to the window. */
  onBack: () => void;
  /** Saved: the next window, or the app. */
  onDone: () => void;
};

export type UpdateFeature = {
  id: AppFeatureId;
  title: (t: ProfilesText) => string;
  text: (t: ProfilesText, profile: ApiProfile) => ReactNode;
  cta: (t: ProfilesText) => string;
  art: ComponentType;
  /** The screen the window's button opens: the feature's setup step, without a step count. */
  setupScreen: ComponentType<UpdateFeatureScreenProps>;
  isSetUp: (profile: ApiProfile) => boolean;
};

/** The avatars (ACCT-PROF-05): "Choose my avatar" opens "Your profile". */
const AvatarsSetupScreen = ({ profile, store, onBack, onDone, ...rest }: UpdateFeatureScreenProps) => (
  <ProfileSetupStep
    {...rest}
    profile={profile}
    onBack={onBack}
    onNext={async (answer) => {
      await saveProfileSetup(store, profile.id, answer);
      onDone();
    }}
  />
);

export const AVATARS_UPDATE_FEATURE: UpdateFeature = {
  id: "avatars",
  title: (t) => t("profiles.whatsNew.avatars.title"),
  text: (t, profile) => withBoldName(t, "profiles.whatsNew.avatars.text", profile.name),
  cta: (t) => t("profiles.whatsNew.avatars.cta"),
  art: () => <AvatarRowArt />,
  setupScreen: AvatarsSetupScreen,
  isSetUp: (profile) => profile.features?.avatars === "set",
};

/** Every feature with a window, in the order the windows show; the avatars first. */
export const UPDATE_FEATURES: readonly UpdateFeature[] = [AVATARS_UPDATE_FEATURE];

/** The windows this profile still has to see, in registry order. */
export const pendingUpdateWindows = (profile: ApiProfile | null, features: readonly UpdateFeature[] = UPDATE_FEATURES): UpdateFeature[] => {
  if (!profile) return [];
  const pending = pendingUpdateFeatures(profile);
  return features.filter((feature) => pending.includes(feature.id) && !feature.isSetUp(profile));
};

/** UX-SETUP-10: the profile still has the "Your profile" step to go through (made since the avatars, never answered). */
export const needsProfileSetupStep = (profile: Pick<ApiProfile, "createdAt" | "features"> | null | undefined): boolean =>
  !!profile && pendingSetupFeatures(profile).includes("avatars");

/**
 * The window queue of the picked profile: the first pending feature, until its window is answered here (the
 * profile's saved answer then keeps it out on every app; until the save is back it is kept out on this screen).
 */
export const useUpdateFeatures = (profile: ApiProfile | null, features: readonly UpdateFeature[] = UPDATE_FEATURES) => {
  const [handled, setHandled] = useState<readonly string[]>([]);
  const queue = useMemo(
    () => (profile ? pendingUpdateWindows(profile, features).filter((feature) => !handled.includes(`${profile.id}:${feature.id}`)) : []),
    [features, handled, profile],
  );
  const markHandled = useCallback(
    (id: AppFeatureId) => {
      if (!profile) return;
      setHandled((current) => [...current, `${profile.id}:${id}`]);
    },
    [profile],
  );
  return { current: queue[0] ?? null, queue, markHandled };
};

export type UpdateFeaturesHostProps = Omit<UpdateFeatureScreenProps, "profile" | "onBack" | "onDone"> & {
  /** The picked profile; null while none is. */
  profile: ApiProfile | null;
  laterLabel?: string;
  /** Places a feature's screen (it covers the app): the app's setup page around the card. */
  frame: (screen: ReactNode) => ReactNode;
  features?: readonly UpdateFeature[];
};

/**
 * Mounted once the app shows the picked profile's content: the "New in this update" window over it for each pending
 * feature, and the feature's screen when its button is pressed. Nothing when nothing is pending.
 */
export function UpdateFeaturesHost({ profile, store, t, log, frame, features, laterLabel, ...screen }: UpdateFeaturesHostProps) {
  const { current, markHandled } = useUpdateFeatures(profile, features);
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (!profile || !current) return null;
  const key = `${profile.id}:${current.id}`;

  if (openFor === key) {
    const Screen = current.setupScreen;
    return (
      <div className="fixed inset-0 z-[70] overflow-y-auto bg-background" data-testid="whats-new-screen" data-feature={current.id}>
        {frame(
          <Screen
            {...screen}
            profile={profile}
            store={store}
            t={t}
            log={log}
            onBack={() => {
              log("profiles.whatsNew.back", { profileId: profile.id, feature: current.id });
              setOpenFor(null);
            }}
            onDone={() => {
              log("profiles.whatsNew.set", { profileId: profile.id, feature: current.id });
              setOpenFor(null);
              markHandled(current.id);
            }}
          />,
        )}
      </div>
    );
  }

  const Art = current.art;
  return (
    <WhatsNewWindow
      feature={current.id}
      badge={t("profiles.whatsNew.badge")}
      art={<Art />}
      title={current.title(t)}
      text={current.text(t, profile)}
      laterLabel={laterLabel ?? t("profiles.whatsNew.later")}
      ctaLabel={current.cta(t)}
      onLater={() => {
        log("profiles.whatsNew.later", { profileId: profile.id, feature: current.id });
        markHandled(current.id);
        // Saved on the profile so no app shows it again; offline, it shows again at the next start.
        void store.editProfile(profile.id, { features: { [current.id]: "later" } }).catch((error: unknown) => {
          log("profiles.whatsNew.later_failed", { profileId: profile.id, feature: current.id, error: String(error) });
        });
      }}
      onCta={() => {
        log("profiles.whatsNew.open", { profileId: profile.id, feature: current.id });
        setOpenFor(key);
      }}
    />
  );
}
