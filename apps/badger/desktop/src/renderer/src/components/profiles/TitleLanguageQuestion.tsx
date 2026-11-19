/**
 * ACCT-PROF-03: "How should titles appear?", asked once of a profile created since the question exists, right after
 * the profile is picked. In this computer's first setup it is "Step 2 of N", right after the library key
 * (UX-SETUP-01); at any other time it shows alone, without a step count. "App language everywhere" starts selected.
 * The options are the shared `TitleLanguageChoice` (`@space/ui/title-language`); the frame is this app's setup card.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, CardFooter } from "@space/ui";
import { DesktopStartupCard, DesktopStartupControls, DesktopStartupPage } from "@space/desktop-shell/components";
import { DEFAULT_TITLE_LANGUAGE, type TitleLanguage, type TitleLanguageTexts } from "@space/shared/titleLanguage";
import { TitleLanguageChoice } from "@space/ui/title-language";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import mascotWebp from "@/assets/mascot.webp";

type TitleLanguageQuestionProps = {
  /** The step in this computer's first setup, or null when the question shows alone. */
  step: { current: number; total: number } | null;
  onAnswer: (choice: TitleLanguage) => void;
};

export default function TitleLanguageQuestion({ step, onAnswer }: TitleLanguageQuestionProps) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<TitleLanguage>(DEFAULT_TITLE_LANGUAGE);
  return (
    <div data-testid="title-language-question">
      <DesktopStartupPage
        nebula="badger"
        mainClassName="pb-12 pt-32"
        controls={
          step ? (
            <DesktopStartupControls>
              <SetupLanguageMenu />
            </DesktopStartupControls>
          ) : undefined
        }
      >
        <DesktopStartupCard
          eyebrow={step ? <span>{t("firstSetup.title")}</span> : undefined}
          progress={
            step
              ? {
                  current: step.current,
                  total: step.total,
                  label: t("firstSetup.stepOf", { current: step.current, total: step.total }),
                  testId: "title-language-progress",
                }
              : undefined
          }
          title={t("titleLanguage.question")}
          description={t("titleLanguage.intro")}
          mascotSrc={mascotWebp}
          mascotAlt={t("brand.mascotAlt")}
          maxWidthClassName="max-w-2xl"
          contentClassName="space-y-5"
          footer={
            <CardFooter className="justify-end gap-3">
              <Button data-testid="title-language-continue" onClick={() => onAnswer(choice)}>
                {step && step.current === step.total ? t("firstSetup.finish") : t("firstSetup.next")}
              </Button>
            </CardFooter>
          }
        >
          <TitleLanguageChoice
            texts={t("titleLanguage", { returnObjects: true }) as TitleLanguageTexts}
            ariaLabel={t("titleLanguage.question")}
            value={choice}
            onChange={setChoice}
          />
        </DesktopStartupCard>
      </DesktopStartupPage>
    </div>
  );
}
