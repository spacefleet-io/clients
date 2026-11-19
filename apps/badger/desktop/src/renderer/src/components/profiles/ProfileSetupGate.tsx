/**
 * UX-SETUP-10: "Your profile" right after the profile is picked, for a profile created since the avatars that has not
 * gone through it on any app. In this computer's first setup it is "Step 2 of N", right after the library key
 * (UX-SETUP-01); at any other time it shows alone. Next saves the name, the avatar and `features.avatars = "set"`.
 *
 * UX-UPDATE-01: a profile from before an update's feature sees its "New in this update" window over the app instead
 * (`UpdateFeaturesHost`); its button opens the same screen, alone.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DesktopStartupControls, DesktopStartupPage } from "@space/desktop-shell/components";
import { ProfileSetupStep, UpdateFeaturesHost, needsProfileSetupStep, saveProfileSetup } from "@space/desktop-shell/profile-setup";
import type { ApiProfile } from "@space/shared/profiles";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import { profileStore, useProfiles } from "@/lib/profileStore";
import { noteProfileStepSaving, settleProfileStep, useSetupRunState } from "@/lib/titleLanguageSetup";
import { rendererLogger } from "@/logger";
import mascotWebp from "@/assets/mascot.webp";

const logger = rendererLogger.child({ scope: "profile-setup" });
const log = (event: string, data: Record<string, unknown>) => logger.info(data, event);

/**
 * Badger's setup page around a profile screen; the language menu only while the first setup runs. A short window
 * gets less room around the card, as the key step does, so "Your profile" fits 1200x600 (UX-SETUP-08).
 */
const SetupFrame = ({ numbered, children }: { numbered: boolean; children: ReactNode }) => (
  <DesktopStartupPage
    nebula="badger"
    mainClassName="pb-12 pt-32 [@media(max-height:700px)]:pb-4 [@media(max-height:700px)]:pt-16"
    controls={
      numbered ? (
        <DesktopStartupControls>
          <SetupLanguageMenu />
        </DesktopStartupControls>
      ) : undefined
    }
  >
    {children}
  </DesktopStartupPage>
);

export default function ProfileSetupGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const profiles = useProfiles();
  // The step shown, read from the run's state so it follows the run.
  const { profileStep: step } = useSetupRunState();
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);

  const profile = profiles.profiles.find((candidate) => candidate.id === profiles.activeId) ?? null;
  // SF_PROFILE_SETUP=off (test harnesses): never asked, the setup counts on without it.
  const ask = !!profile && window.sf?.profileSetupOff !== true && answeredFor !== profile.id && needsProfileSetupStep(profile);
  const settledWithoutAsking = !!profile && !ask && answeredFor !== profile.id;

  useEffect(() => {
    // Not needed for this profile (an older profile, or set on another app): the setup counts on without it.
    if (!settledWithoutAsking) return;
    logger.info({}, "profile setup not owed here: the setup counts on without it");
    settleProfileStep(false);
  }, [settledWithoutAsking]);

  if (!ask || !profile) return <>{children}</>;
  return (
    <div data-testid="profile-setup-gate">
      <SetupFrame numbered={!!step}>
        <ProfileSetupStep
          profile={profile}
          t={t}
          progress={
            step
              ? {
                  current: step.current,
                  total: step.total,
                  label: t("firstSetup.stepOf", { current: step.current, total: step.total }),
                  testId: "profile-setup-progress",
                }
              : undefined
          }
          backLabel={t("firstSetup.back")}
          nextLabel={step && step.current === step.total ? t("firstSetup.finish") : t("firstSetup.next")}
          mascotSrc={mascotWebp}
          mascotAlt={t("brand.mascotAlt")}
          log={log}
          onNext={async (answer) => {
            noteProfileStepSaving(true);
            try {
              await saveProfileSetup(profileStore, profile.id, answer);
            } catch (err) {
              noteProfileStepSaving(false);
              throw err;
            }
            logger.info({ profileId: profile.id, avatarId: answer.avatarId, step: step?.current ?? null }, "profile setup saved");
            setAnsweredFor(profile.id);
            settleProfileStep(true);
          }}
        />
      </SetupFrame>
    </div>
  );
}

/** UX-UPDATE-01: the picked profile's "New in this update" windows, over the app. */
export function ProfileUpdateWindows({ profile }: { profile: ApiProfile | null }) {
  const { t } = useTranslation();
  return (
    <UpdateFeaturesHost
      profile={profile}
      store={profileStore}
      t={t}
      log={log}
      backLabel={t("firstSetup.back")}
      nextLabel={t("firstSetup.next")}
      mascotSrc={mascotWebp}
      mascotAlt={t("brand.mascotAlt")}
      frame={(screen) => <SetupFrame numbered={false}>{screen}</SetupFrame>}
    />
  );
}
