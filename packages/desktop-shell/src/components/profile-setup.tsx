/**
 * The "Your profile" setup step (UX-SETUP-10) and the "New in this update" window (UX-UPDATE-01), shared by Badger and
 * Parrot on the computer and in the browser (REL-FAM-02). The step is the app's setup card (`DesktopStartupCard`):
 * the profile's avatar big, its name, and the 22 avatars as round tiles (the shared `AvatarChooser`, `round`), Back
 * and Next. In a window 640px high or less (Badger 1200x600, Parrot 800x560) the step bar, the big avatar, the name
 * field, the tiles, the gaps and the buttons are smaller, so the step fits with its large mascot (UX-SETUP-08), and the
 * card is at most 640px wide, so it stays clear of the language button in Parrot's 800px window.
 * The window is the update card drawn in desktop-modal.png: badge, art, title, text and its two buttons.
 * The words are the `profiles.setup.*` and `profiles.whatsNew.*` texts every app loads (`withProfilesTexts`); Back
 * and Next are the app's own.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { profileAvatarIdOf, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { normalizeProfileName, type ApiProfile } from "@space/shared/profiles";
import { ProfileActionError, profileErrorKey, type ProfileStore } from "@space/shared/profileStore";
import { Button, CardFooter, Input, Label } from "@space/ui";
import { AvatarChooser, ProfileAvatar, type ProfilesLog, type ProfilesText } from "@space/ui/profiles";
import { DesktopStartupCard, type DesktopStartupProgress } from "./desktop-startup-card";

/** What Next on the step saves: the name and avatar shown, also when unchanged (UX-SETUP-09). */
export type ProfileSetupAnswer = { name: string; avatarId: ProfileAvatarId };

/**
 * UX-SETUP-10: the step's Next in ONE `PATCH /profiles/{id}`: the name and avatar shown, and the avatars feature
 * counted as set, so no app asks this profile again.
 */
export const saveProfileSetup = (store: ProfileStore, profileId: string, answer: ProfileSetupAnswer) =>
  store.editProfile(profileId, { name: answer.name, avatarId: answer.avatarId, features: { avatars: "set" } });

export type ProfileSetupStepProps = {
  profile: ApiProfile;
  t: ProfilesText;
  /** "Step N of M" while the app's first setup runs; none when the step shows alone. */
  progress?: DesktopStartupProgress;
  backLabel: string;
  nextLabel: string;
  /**
   * No way back: greyed out during the first setup (the step right after a finished one); shown alone, there is no
   * Back at all and Next takes the full width (UX-SETUP-10).
   */
  onBack?: () => void;
  /** Saves the answer (`saveProfileSetup`); a refusal is shown under the form and the step stays. */
  onNext: (answer: ProfileSetupAnswer) => Promise<unknown>;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
  log: ProfilesLog;
};

/**
 * "Your profile" (UX-SETUP-10): the name filled in from the profile and its current avatar picked (the one the server
 * gave it at creation, ACCT-PROF-05). The big avatar follows the pick. No "Add someone else".
 */
export function ProfileSetupStep({
  profile,
  t,
  progress,
  backLabel,
  nextLabel,
  onBack,
  onNext,
  mascotSrc,
  mascotAlt,
  mascotGlowClassName,
  log,
}: ProfileSetupStepProps) {
  const [name, setName] = useState(profile.name);
  const [avatarId, setAvatarId] = useState<ProfileAvatarId>(() => profileAvatarIdOf(profile));
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const nameId = useId();
  const nameValid = normalizeProfileName(name) !== null;
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor.current === profile.id) return;
    shownFor.current = profile.id;
    log("profiles.setup.shown", { profileId: profile.id, avatarId: profileAvatarIdOf(profile), step: progress ? `${progress.current}/${progress.total}` : "alone" });
  }, [log, profile, progress]);

  const next = async () => {
    if (!nameValid || busy) return;
    setBusy(true);
    setErrorKey(null);
    log("profiles.setup.next", { profileId: profile.id, avatarId, nameChanged: name.trim() !== profile.name, avatarChanged: avatarId !== profileAvatarIdOf(profile) });
    try {
      await onNext({ name, avatarId });
    } catch (error) {
      const code = error instanceof ProfileActionError ? error.code : "unknown";
      log("profiles.setup.failed", { profileId: profile.id, code });
      setErrorKey(profileErrorKey(code));
      setBusy(false);
    }
  };

  return (
    <div
      className="w-full max-w-3xl [@media(max-height:640px)]:max-w-[40rem] [@media(max-height:640px)]:[&_[data-testid=setup-step-bar]]:space-y-2 [@media(max-height:640px)]:[&_div:has(>[data-testid=setup-step-bar])]:pb-3"
      data-testid="profile-setup-step"
      data-profile={profile.id}
    >
      <DesktopStartupCard
        progress={progress}
        title={t("profiles.setup.title")}
        description={t("profiles.setup.lead")}
        mascotSrc={mascotSrc}
        mascotAlt={mascotAlt}
        mascotGlowClassName={mascotGlowClassName}
        maxWidthClassName="max-w-3xl [@media(max-height:640px)]:max-w-[40rem]"
        contentClassName="space-y-6 [@media(max-height:640px)]:space-y-4 [@media(max-height:640px)]:pb-4"
        footer={
          <CardFooter className="gap-4 [@media(max-height:640px)]:pb-5">
            {onBack || progress ? (
              <Button
                type="button"
                variant="ghost"
                className="h-12 flex-1 rounded-full border border-border text-base font-bold [@media(max-height:640px)]:h-10"
                disabled={!onBack || busy}
                onClick={onBack}
                data-testid="profile-setup-back"
              >
                {backLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              className="h-12 flex-1 rounded-full text-base font-bold [@media(max-height:640px)]:h-10"
              disabled={!nameValid || busy}
              pending={busy}
              onClick={() => void next()}
              data-testid="profile-setup-next"
            >
              {nextLabel}
            </Button>
          </CardFooter>
        }
      >
        <form
          className="flex items-center gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void next();
          }}
        >
          <span data-testid="profile-setup-preview">
            <ProfileAvatar
              profile={{ avatar: profile.avatar, avatarId }}
              size="lg"
              className="rounded-full bg-secondary [@media(max-height:640px)]:h-16 [@media(max-height:640px)]:w-16"
            />
          </span>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={nameId} className="text-xs text-muted-foreground">
              {t("profiles.setup.name")}
            </Label>
            <Input
              id={nameId}
              value={name}
              maxLength={40}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              className="h-12 rounded-2xl text-lg [@media(max-height:640px)]:h-10"
              data-testid="profile-setup-name"
            />
          </div>
        </form>
        <AvatarChooser value={avatarId} onChange={setAvatarId} t={t} variant="round" disabled={busy} />
        {errorKey ? (
          <p role="alert" className="text-sm text-destructive" data-testid="profile-setup-error">
            {t(errorKey)}
          </p>
        ) : null}
      </DesktopStartupCard>
    </div>
  );
}

/** A text with `{{name}}` whose name is written in bold, as drawn ("Choose one for **Marie**."). */
export const withBoldName = (t: ProfilesText, key: string, name: string): ReactNode => {
  const mark = "\u2063name\u2063";
  const [before, after = ""] = t(key, { name: mark }).split(mark);
  return (
    <>
      {before}
      <b className="font-semibold text-foreground" data-testid="whats-new-name">
        {name}
      </b>
      {after}
    </>
  );
};

/** The avatars feature's art: five avatars of the pack in an overlapping row. */
export const AVATARS_FEATURE_ART: readonly ProfileAvatarId[] = ["fox", "owl", "panda", "rocket", "octopus"];

export function AvatarRowArt({ ids = AVATARS_FEATURE_ART }: { ids?: readonly ProfileAvatarId[] }) {
  return (
    <div aria-hidden className="flex justify-center" data-testid="whats-new-art">
      {ids.map((id) => (
        <ProfileAvatar key={id} profile={{ avatar: 0, avatarId: id }} size="lg" className="-mx-1.5 h-16 w-16 rounded-full border-[3px] border-card bg-secondary" />
      ))}
    </div>
  );
}

export type WhatsNewWindowProps = {
  feature: string;
  badge: string;
  art: ReactNode;
  title: string;
  text: ReactNode;
  laterLabel: string;
  ctaLabel: string;
  onLater: () => void;
  onCta: () => void;
};

/**
 * "New in this update" (UX-UPDATE-01): one window per new feature over the app, right after the profile is picked.
 * Later and the feature's button are its only ways out; nothing closes it by itself.
 */
export function WhatsNewWindow({ feature, badge, art, title, text, laterLabel, ctaLabel, onLater, onCta }: WhatsNewWindowProps) {
  const titleId = useId();
  const textId = useId();
  const cta = useRef<HTMLButtonElement>(null);
  useEffect(() => cta.current?.focus(), [feature]);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(10,11,20,0.72)] p-4 backdrop-blur-[4px]" data-testid="whats-new-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-testid="whats-new-window"
        data-feature={feature}
        className="w-full max-w-[500px] rounded-[28px] border border-border bg-card/95 px-5 pb-7 pt-[34px] text-center text-card-foreground shadow-2xl sm:px-9"
      >
        <span className="mb-4 inline-block rounded-full bg-primary/15 px-3 py-[5px] text-xs font-bold uppercase tracking-[0.08em] text-primary" data-testid="whats-new-badge">
          {badge}
        </span>
        <div className="mb-5 mt-1">{art}</div>
        <h2 id={titleId} className="font-display text-[26px] font-semibold leading-tight">
          {title}
        </h2>
        <p id={textId} className="mb-[26px] mt-2.5 text-[15px] leading-[1.45] text-muted-foreground">
          {text}
        </p>
        <div className="flex justify-center gap-3">
          <Button type="button" variant="ghost" className="h-[46px] min-w-0 flex-1 rounded-full border border-border px-3 text-[15px] font-bold sm:w-[140px] sm:flex-none" onClick={onLater} data-testid="whats-new-later">
            {laterLabel}
          </Button>
          <Button ref={cta} type="button" className="h-[46px] min-w-0 flex-[1.4] rounded-full px-3 text-[15px] font-bold sm:w-[200px] sm:flex-none" onClick={onCta} data-testid="whats-new-cta">
            {ctaLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
