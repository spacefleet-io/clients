import { useTranslation } from "react-i18next";
import { Select } from "@space/ui";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { SettingField } from "../kit";

export default function DownloadsSection() {
  const { t } = useTranslation();
  const { config, updateSetting } = useClientSettings();

  return (
    <div className="space-y-4">
      <SettingField
        label={t("settings.offlineExportFormat.label")}
        htmlFor="offlineExportFormat"
        hint={t("settings.offlineExportFormat.help")}
      >
        <Select
          id="offlineExportFormat"
          data-testid="settings-offline-export-format"
          value={config.offlineExportFormat}
          onChange={(e) =>
            updateSetting("offlineExportFormat", (e.target.value === "mp4" ? "mp4" : "mkv") as "mkv" | "mp4")
          }
        >
          <option value="mkv">{t("settings.offlineExportFormat.mkv")}</option>
          <option value="mp4">{t("settings.offlineExportFormat.mp4")}</option>
        </Select>
        {config.offlineExportFormat === "mp4" ? (
          <div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {t("settings.offlineExportFormat.mp4Warning")}
          </div>
        ) : null}
      </SettingField>
    </div>
  );
}
