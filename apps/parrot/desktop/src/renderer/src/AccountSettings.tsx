import { useState } from "react";
import { CreditCard, HardDrive, Info, LifeBuoy, LogOut, MessageSquare, RefreshCw, SlidersHorizontal, Smartphone, User } from "lucide-react";
import { Button, LanguageSelect, Switch } from "@space/ui";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";
import { useErrorReportsSetting } from "@space/error-report/react";
import { CreditsPanel, DesktopSettingsShell, ErrorReportsLink, OpenSourceNotice, type DesktopSettingsGroup } from "@space/desktop-shell/components";
import { ParrotSettingsRow as Row } from "@space/ui/parrot/screens";
import { PARROT_EVEN_VOLUME_LEVELS, type ParrotEvenVolumeLevel } from "@space/parrot-core";
import type { ProfileStore } from "@space/shared/profileStore";
import type { ParrotLanguage, ParrotState } from "../../shared/ipc";
import { pickLanguage } from "./accountLanguage";
import { setEvenVolume, useEvenVolume } from "./evenVolume";
import { errorReports, errorReportsLog } from "./errorReports";
import type { Translate } from "./i18n";
import { ProfilesSection } from "./profiles";
import { useNewsOptIn } from "./newsOptIn";
import { FounderBadge } from "@space/ui/founder";
import { useParrotFounderStatus } from "./founder";
import { newsOptInText } from "@space/legal";
import { ParrotUpdateSection } from "./updates";
import { desktopTourText } from "@space/desktop-shell/tour";
import { localStorageCreditsStore, type CreditsSource } from "@space/metadata-client/credits";
import { OfflineContent, type DescribeKept } from "./OfflineContent";
import { DownloadEverythingRow } from "./ExportJobs";
import { KeyChangeRow } from "./KeyChangeRow";

/** Settings › About's data credits (META-SRC-09): main asks the lookups' metadata service; the last answer stays in localStorage. */
const creditsSource: CreditsSource = {
  load: (product, language) => window.parrot.sourceCredits(product, language),
  store: localStorageCreditsStore,
};
const noLibrary: DescribeKept = () => null;

export type ParrotSettingsSection = "account" | "general" | "offline" | "support" | "about";

type SettingsPageProps = {
  t: Translate;
  email: string;
  /** The signed-in account: "Even out volume" is kept per account. */
  userId: string;
  language: ParrotLanguage;
  onState: (state: ParrotState) => void;
  onPlan: () => void;
  /** The plan dialog is open over this page: the profiles are read again once it closes (the limit follows the plan). */
  planOpen?: boolean;
  onPair: () => void;
  onFeedback: () => void;
  /** PAR-TOUR-04: "Show the tour again" goes back to Home, where the tour opens. */
  onTour: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  initialSection?: ParrotSettingsSection;
  /** The window's profile store (shared with the top bar's avatar menu); null without a bridge (a browser preview). */
  profileStore?: ProfileStore | null;
  /** The avatar menu's "Add profile": the profiles open straight on a new one, then show the list once it is saved or cancelled. */
  profilesStartWith?: "add";
  /** Settings › Manage offline content (OFFL-MANAGE-01): the name, artist and cover of a kept item, from the library (none: no library loaded). */
  describeKept?: DescribeKept;
};

/**
 * The gear's page (UX-SET-01, PAR-NAV-01): Badger's Settings layout from the shared `DesktopSettingsShell`, with the
 * categories on the left. Account holds who is signed in, the plan, pairing another device and the account's profiles
 * (ACCT-PROF-01, ACCT-PROF-02; there is no separate
 * account button or page any more); General holds the language (UX-I18N-01), Even out volume (PAR-PLAY-03), Refresh and
 * Send error reports (REL-LOG-06); Manage offline content lists what is kept on this computer, with sizes and remove
 * (OFFL-MANAGE-01); Help & feedback holds Send feedback (PAR-SUP-01); About & updates holds the version,
 * the updater's state and button and the automatic-updates switch (REL-UPD-05, REL-UPD-01; the section Badger shows
 * too), then "Show the tour again", the open-source line and the credits. Sign out sits under the rail, as in Badger.
 */
export function SettingsPage({
  t,
  email,
  userId,
  language,
  onState,
  onPlan,
  planOpen = false,
  onPair,
  onFeedback,
  onTour,
  onRefresh,
  onSignOut,
  initialSection = "general",
  profileStore = null,
  profilesStartWith,
  describeKept = noLibrary,
}: SettingsPageProps) {
  const [section, setSection] = useState<ParrotSettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  // REL-LOG-06: undefined = no bridge (browser/tests) → row hidden; null = loading.
  const { value: errorReportsOn, set: setErrorReportsOn } = useErrorReportsSetting(errorReports, errorReportsLog);
  // PAR-PLAY-03 item 2: off by default; the level picker shows only while it is on.
  const evenVolume = useEvenVolume(userId);
  // ACCT-NEWS-01: News emails on or off, saved on the account.
  const news = useNewsOptIn(window.parrot);
  const founder = useParrotFounderStatus(window.parrot, userId);
  const newsText = newsOptInText(language);
  // Badger's order: the app's own categories first, then Account.
  const groups: DesktopSettingsGroup<ParrotSettingsSection>[] = [
    {
      id: "app",
      label: t("settings.group.app"),
      sections: [
        { id: "general", label: t("settings.section.general"), icon: SlidersHorizontal },
        { id: "offline", label: t("settings.section.offline"), icon: HardDrive },
        { id: "support", label: t("settings.section.support"), icon: LifeBuoy },
        { id: "about", label: t("settings.section.about"), icon: Info },
      ],
    },
    { id: "account", label: t("settings.group.account"), sections: [{ id: "account", label: t("settings.section.account"), icon: User }] },
  ];

  return (
    <div data-testid="settings-page">
      <DesktopSettingsShell
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        groups={groups}
        activeSection={section}
        onSelect={setSection}
        query={query}
        onQueryChange={setQuery}
        labels={{ navAria: t("settings.navAria"), searchPlaceholder: t("settings.search"), noResults: t("settings.noResults") }}
        sectionDescription={t(`settings.desc.${section}`)}
        railFooter={
          <Button
            type="button"
            variant="ghost"
            className="mt-4 w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
            onClick={onSignOut}
            data-testid="settings-sign-out"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {t("library.signOut")}
          </Button>
        }
      >
        <div className="max-w-2xl">
          {section === "account" ? (
            <>
              <p className="mb-2 text-sm text-muted-foreground" data-testid="account-email">
                {t("account.signedInAs", { email })}
              </p>
              {/* WAIT-FOUND-04: "Founder 🎫 · since the waitlist, {date}" for a founder. */}
              <FounderBadge language={language} status={founder.status} className="mb-2" />
              <Row title={t("library.plan")} body={t("account.planBody")}>
                <Button variant="outline" onClick={onPlan} data-testid="library-plan">
                  <CreditCard className="mr-2 size-4" aria-hidden />
                  {t("library.plan")}
                </Button>
              </Row>
              <Row title={t("library.pairDevice")} body={t("account.pairBody")}>
                <Button variant="outline" onClick={onPair} data-testid="library-pair-device">
                  <Smartphone className="mr-2 size-4" aria-hidden />
                  {t("library.pairDevice")}
                </Button>
              </Row>
              {/* ACCT-KEYCHG-01: replace the media library key, with every media file re-sealed first (STOR-RESEAL-01). */}
              <KeyChangeRow language={language} onState={onState} />
              {/* ACCT-EXPORT-01: every song as plain music files in a folder the user picks. */}
              <DownloadEverythingRow t={t} language={language} />
              {news.value !== undefined ? (
                <Row title={newsText.news} body={newsText.newsHint}>
                  <Switch
                    aria-label={newsText.news}
                    data-testid="settings-news-switch"
                    checked={news.value === true}
                    disabled={news.value === null || news.saving}
                    onCheckedChange={news.set}
                  />
                </Row>
              ) : null}
              {/* No bridge (a browser preview) → no profiles: the token that asks for them lives in main. */}
              {profileStore ? (
                <ProfilesSection store={profileStore} language={language} planOpen={planOpen} startWith={profilesStartWith} />
              ) : null}
            </>
          ) : section === "general" ? (
            <>
              <Row title={t("library.language")} body={t("settings.languageBody")}>
                {/* The language can change at any time after setup (UX-I18N-01); the screen follows at once and the
                    account takes it, for every app, profile and email (UX-I18N-07). */}
                <LanguageSelect
                  className="h-9 w-48"
                  ariaLabel={t("library.language")}
                  value={language}
                  testId="library-language"
                  languages={CLIENT_UI_LANGUAGES}
                  onChange={(code) => void pickLanguage(window.parrot, code).then(onState)}
                />
              </Row>
              <Row title={t("library.refresh")} body={t("settings.refreshBody")}>
                <Button variant="outline" onClick={onRefresh} data-testid="library-refresh">
                  <RefreshCw className="mr-2 size-4" aria-hidden />
                  {t("library.refresh")}
                </Button>
              </Row>
              <Row title={t("settings.evenVolume")} body={t("settings.evenVolumeBody")}>
                <Switch
                  aria-label={t("settings.evenVolume")}
                  data-testid="settings-even-volume-switch"
                  checked={evenVolume.on}
                  onCheckedChange={(on) => setEvenVolume(userId, { ...evenVolume, on })}
                />
              </Row>
              {evenVolume.on ? (
                <Row title={t("settings.evenVolumeLevel")} body={t("settings.evenVolumeLevelBody")}>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    aria-label={t("settings.evenVolumeLevel")}
                    value={evenVolume.level}
                    data-testid="settings-even-volume-level"
                    onChange={(event) => setEvenVolume(userId, { ...evenVolume, level: event.target.value as ParrotEvenVolumeLevel })}
                  >
                    {PARROT_EVEN_VOLUME_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`settings.evenVolumeLevels.${level}`)}
                      </option>
                    ))}
                  </select>
                </Row>
              ) : null}
              {errorReportsOn !== undefined ? (
                <Row
                  title={t("settings.errorReports")}
                  body={
                    <>
                      {t("settings.errorReportsBody")}{" "}
                      <ErrorReportsLink language={language} label={t("settings.errorReportsLink")} testId="settings-error-reports-link" />
                    </>
                  }
                >
                  <Switch
                    aria-label={t("settings.errorReports")}
                    data-testid="settings-error-reports-switch"
                    checked={errorReportsOn === true}
                    disabled={errorReportsOn === null}
                    onCheckedChange={setErrorReportsOn}
                  />
                </Row>
              ) : null}
            </>
          ) : section === "offline" ? (
            <OfflineContent t={t} language={language} describe={describeKept} />
          ) : section === "support" ? (
            <Row title={t("library.feedback")} body={t("settings.feedbackBody")}>
              <Button variant="outline" onClick={onFeedback} data-testid="library-feedback">
                <MessageSquare className="mr-2 size-4" aria-hidden />
                {t("library.feedback")}
              </Button>
            </Row>
          ) : (
            <>
              <ParrotUpdateSection language={language} />
              <div className="mt-4">
                <Row title={desktopTourText(language, "showAgain")} body={desktopTourText(language, "showAgainBody", { app: "Parrot" })}>
                  <Button variant="outline" onClick={onTour} data-testid="settings-show-tour">
                    {desktopTourText(language, "showAgain")}
                  </Button>
                </Row>
              </div>
              {/* Third-party code shipped in the app, with its licence (Apache-2.0 attribution of the ALAC decoder), then the
                  outside data sources (UX-SET-02): the app's one credits place, opened by its own GPL-3.0 line and source
                  link (UX-SET-03). */}
              <Row
                title={t("settings.openSource")}
                body={
                  <>
                    <OpenSourceNotice language={language} product="parrot" />
                    <span className="mt-2 block">{t("settings.openSourceBody")}</span>
                  </>
                }
                testId="settings-open-source"
              />
              <CreditsPanel language={language} product="parrot" source={creditsSource} />
            </>
          )}
        </div>
      </DesktopSettingsShell>
    </div>
  );
}
