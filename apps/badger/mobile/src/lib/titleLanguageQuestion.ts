/**
 * When Badger asks "How should titles appear?" (ACCT-PROF-03): only for a profile created since the question exists
 * that never answered it (`needsTitleLanguageQuestion`); profiles from before are never asked. The phone's first setup
 * asks it as a numbered step after the key and "Who's watching?"; otherwise (a profile created later, the TV) the
 * navigator shows it on its own screen right after the profile is picked.
 */
import { needsTitleLanguageQuestion, type TitleLanguage } from "@space/shared/titleLanguage";
import type { ProfilesSnapshot } from "@space/shared/profileStore";
import { answerAppSettings } from "./appSettings";
import { profileStore, useProfiles } from "./profiles/profileStore";
import { getActiveTitleLanguageAnswer, useActiveTitleLanguageAnswer } from "./profileSettings";

/**
 * Saves the answer (setup step or standalone screen, phone and TV) in the active profile's settings, even when it is
 * the preselected default the screen already shows (UX-SETUP-09), so the question is not asked again.
 */
export const answerTitleLanguage = (titleLanguage: TitleLanguage): void => {
  answerAppSettings({ titleLanguage });
};

/**
 * True when the active profile must answer; null while that is not known yet (no profile picked, or its settings
 * not read).
 */
export const activeProfileNeedsTitleLanguage = (
  snapshot: Pick<ProfilesSnapshot, "profiles" | "activeId">,
  answer: { titleLanguage?: unknown } | null,
): boolean | null => {
  const profile = snapshot.profiles.find(({ id }) => id === snapshot.activeId);
  if (!profile || answer === null) return null;
  return needsTitleLanguageQuestion(profile, answer);
};

/**
 * The phone setup's check (`askTitleLanguageInSetup`): counted while not known yet, so a new account's setup says
 * "step 1 of 4" at the key and keeps that count once its new profile is picked.
 */
export const titleLanguageAskedInSetup = (): boolean =>
  activeProfileNeedsTitleLanguage(profileStore.getSnapshot(), getActiveTitleLanguageAnswer()) !== false;

/** The navigator's standalone question: shown only once known to be needed. */
export const useTitleLanguageQuestion = (): boolean => activeProfileNeedsTitleLanguage(useProfiles(), useActiveTitleLanguageAnswer()) === true;
