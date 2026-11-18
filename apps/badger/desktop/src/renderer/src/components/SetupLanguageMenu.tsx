/**
 * UX-SETUP-08: the language button of every setup screen (language, sign-in, sign-up, email check, library key, first
 * setup questions). It sits in the window's top-right (`DesktopStartupControls`, which the screen passes as its
 * `controls`), never inside the card, and keeps that spot from one step to the next. A pick is the same as the
 * language step's: the screen speaks it at once and, signed in, the account keeps it (`pickUiLanguage`).
 */
import { useTranslation } from "react-i18next";
import { LanguageMenu } from "@space/ui";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage, type ClientUiLanguage } from "@space/shared";
import { loadClientConfig } from "@/lib/config";
import { pickUiLanguage } from "@/lib/accountUiLanguage";

export default function SetupLanguageMenu({ onPicked }: { onPicked?: (language: ClientUiLanguage) => void }) {
  const { t } = useTranslation();
  return (
    <LanguageMenu
      current={loadClientConfig().uiLanguage}
      languages={CLIENT_UI_LANGUAGES}
      onSelect={(next) => {
        if (!isClientUiLanguage(next)) return;
        pickUiLanguage(next);
        onPicked?.(next);
      }}
      ariaLabel={t("settings.ui.language")}
    />
  );
}
