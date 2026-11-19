/**
 * Setup step 0 on a computer (UX-SETUP-08): before the sign-in, a computer that has not picked its language yet asks
 * "Choose your language" as a scrolling list (UX-LIST-01), with no step count. Next keeps the pick and shows the sign-in
 * (or sign-up) in that language; the numbered steps start after the sign-in, with the library key as "Step 1".
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, CardFooter } from "@space/ui";
import { Flag } from "@space/ui/flag";
import { ChoiceList, DesktopStartupCard, DesktopStartupControls, DesktopStartupPage } from "@space/desktop-shell/components";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage, type ClientUiLanguage } from "@space/shared";
import mascotWebp from "@/assets/mascot.webp";
import { loadClientConfig } from "@/lib/config";
import { pickUiLanguage } from "@/lib/accountUiLanguage";
import { isSetupLanguageChosen, markSetupLanguageChosen } from "@/lib/setupLanguage";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "first-setup" });

export default function LanguageFirstGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(isSetupLanguageChosen);
  // The computer's language is preselected (UX-I18N-01).
  const [language, setLanguage] = useState<ClientUiLanguage>(() => loadClientConfig().uiLanguage);

  if (chosen) return <>{children}</>;
  return (
    <div data-testid="setup-language">
      <DesktopStartupPage
        nebula="badger"
        // A short window (the 600 px minimum) gets less room around the card, so the 5 languages show whole there too.
        mainClassName="pb-12 pt-32 [@media(max-height:700px)]:pb-4 [@media(max-height:700px)]:pt-20"
        controls={
          <DesktopStartupControls>
            <SetupLanguageMenu onPicked={setLanguage} />
          </DesktopStartupControls>
        }
      >
        <DesktopStartupCard
          title={t("firstSetup.language.title")}
          mascotSrc={mascotWebp}
          mascotAlt={t("brand.mascotAlt")}
          maxWidthClassName="max-w-xl"
          footer={
            <CardFooter className="justify-end">
              <Button
                data-testid="setup-language-next"
                onClick={() => {
                  log.info({ language }, "[first-setup] language chosen before sign-in");
                  markSetupLanguageChosen();
                  setChosen(true);
                }}
              >
                {t("firstSetup.next")}
              </Button>
            </CardFooter>
          }
        >
          <ChoiceList
            name="language"
            value={language}
            ariaLabel={t("firstSetup.language.title")}
            maxHeightClassName="max-h-64"
            options={CLIENT_UI_LANGUAGES.map((option) => ({ value: option.code, label: option.nativeName, lead: <Flag code={option.code} /> }))}
            onChange={(next) => {
              if (!isClientUiLanguage(next)) return;
              setLanguage(next);
              // The screen speaks the picked language at once.
              pickUiLanguage(next);
            }}
          />
        </DesktopStartupCard>
      </DesktopStartupPage>
    </div>
  );
}
