import { useEffect, useState, type ReactNode } from "react";
import { readProfileSettingsRow, scopedProfileSettingsKey } from "@space/shared/profileSettings";
import { viewingScopeFor } from "@space/shared/profileViewing";
import { needsTitleLanguageQuestion, type TitleLanguage } from "@space/shared/titleLanguage";
import { useLibraryActions, useLibraryShell } from "@/lib/libraryContext";
import { loadClientConfig, saveClientConfig } from "@/lib/config";
import { useProfiles } from "@/lib/profileStore";
import { settleTitleQuestion, titleQuestionStep, useSetupRunState } from "@/lib/titleLanguageSetup";
import { rendererLogger } from "@/logger";
import TitleLanguageQuestion from "./TitleLanguageQuestion";

const log = rendererLogger.child({ scope: "title-language" });

/**
 * ACCT-PROF-03: once the picked profile's settings are read from the open library, a profile that must answer
 * "How should titles appear?" (`needsTitleLanguageQuestion`: created since the question exists, never answered on any
 * app) sees it before the app. The answer goes to the profile's settings (`titleLanguage`) through the client config,
 * which writes the changed field to the profile's row.
 */
export default function TitleLanguageGate({ children }: { children: ReactNode }) {
  const profiles = useProfiles();
  const { loading, error, datasetStatus } = useLibraryShell();
  const { getSharedSetting } = useLibraryActions();
  // Re-render when the setup run changes (the step shown).
  useSetupRunState();
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);

  const profile = profiles.profiles.find((candidate) => candidate.id === profiles.activeId) ?? null;
  const ready = !loading && datasetStatus.core && !error;
  const row = profile ? getSharedSetting(scopedProfileSettingsKey(viewingScopeFor(profile))) : null;
  const settings = row ? readProfileSettingsRow(row.value, row.updatedAt) : null;
  const ask = !!profile && ready && answeredFor !== profile.id && needsTitleLanguageQuestion(profile, settings);
  const settledWithoutAsking = !!profile && (ready || !!error) && !ask && answeredFor !== profile.id;

  useEffect(() => {
    // Not needed for this profile (an older profile, or answered on another app): the setup counts on without it.
    if (settledWithoutAsking) settleTitleQuestion(false);
  }, [settledWithoutAsking]);

  useEffect(() => {
    if (ask && profile) log.info({ profileId: profile.id, createdAt: profile.createdAt }, "title language question shown");
  }, [ask, profile]);

  if (!ask || !profile) return <>{children}</>;
  const answer = (choice: TitleLanguage) => {
    log.info({ profileId: profile.id, choice }, "title language answered");
    // The config read fresh: the profile's other settings stay as the library holds them.
    saveClientConfig({ ...loadClientConfig(), titleLanguage: choice, configured: true });
    setAnsweredFor(profile.id);
    settleTitleQuestion(true);
  };
  return <TitleLanguageQuestion step={titleQuestionStep()} onAnswer={answer} />;
}
