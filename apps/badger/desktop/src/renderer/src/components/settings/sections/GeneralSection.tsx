import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { Button, LanguageSelect } from "@space/ui";
import { CLIENT_UI_LANGUAGES } from "@space/shared";
import { profileTitleLanguage, type TitleLanguageTexts } from "@space/shared/titleLanguage";
import { TitleLanguageChoice } from "@space/ui/title-language";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { SettingField, SettingPanel } from "../kit";

export default function GeneralSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { config, updateSetting } = useClientSettings();

  return (
    <div className="space-y-4">
      <SettingField label={t("settings.ui.language")} htmlFor="uiLang">
        <LanguageSelect
          id="uiLang"
          testId="settings-ui-language"
          ariaLabel={t("settings.ui.language")}
          value={config.uiLanguage}
          languages={CLIENT_UI_LANGUAGES}
          onChange={(code) => updateSetting("uiLanguage", code)}
        />
      </SettingField>

      {/* ACCT-PROF-03: the active profile's title option; changing it fetches the other set in the background. */}
      <SettingField label={t("titleLanguage.settingTitle")} hint={t("titleLanguage.settingDescription")}>
        <div data-testid="settings-title-language">
          <TitleLanguageChoice
            texts={t("titleLanguage", { returnObjects: true }) as TitleLanguageTexts}
            ariaLabel={t("titleLanguage.settingTitle")}
            value={profileTitleLanguage(config)}
            onChange={(next) => updateSetting("titleLanguage", next)}
          />
        </div>
      </SettingField>

      <SettingPanel>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-between px-0 text-left text-foreground hover:bg-transparent"
          onClick={() => navigate("/home?edit=1&returnTo=settings")}
        >
          <span className="inline-flex items-center gap-2 font-semibold">
            <Pencil className="h-4 w-4 text-primary" />
            {t("settings.ui.editHomeLayout")}
          </span>
        </Button>
      </SettingPanel>
    </div>
  );
}
