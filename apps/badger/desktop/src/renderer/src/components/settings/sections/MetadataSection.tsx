import { useTranslation } from "react-i18next";
import { Switch } from "@space/ui";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { SettingGroup, SettingRow } from "../kit";

// The own-key setting was removed (META-DIRECT-03): every lookup goes through the metadata service.
export default function MetadataSection() {
  const { t } = useTranslation();
  const { config, updateNestedSetting } = useClientSettings();

  return (
    <div className="space-y-4">
      <SettingGroup>
        <SettingRow
          title={t("settings.advanced.metadataTools.title")}
          description={t("settings.advanced.metadataTools.subtitle")}
          control={
            <Switch
              checked={config.enableMetadataTools}
              onCheckedChange={(checked) => updateNestedSetting({ enableMetadataTools: checked })}
            />
          }
        />
      </SettingGroup>
    </div>
  );
}
