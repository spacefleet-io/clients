import { useTranslation } from "react-i18next";
import { Select, Switch } from "@space/ui";
import { formatMediaLanguageOptionLabel } from "@space/shared/media-languages";
import { AUDIO_LANGUAGE_CHOICES } from "@space/shared/profileSettings";
import { QUALITY_ORDER, coerceLanguageChoice, type QualityPreset } from "@/lib/config";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { SettingField, SettingGroup, SettingRow } from "../kit";

const PLAYBACK_QUALITIES: QualityPreset[] = QUALITY_ORDER;

/** The select's value for no language: Original audio, or the file's own default subtitle. */
const NO_LANGUAGE = "";

export default function PlaybackSection() {
  const { t } = useTranslation();
  const { config, updateSetting } = useClientSettings();

  return (
    <div className="space-y-4">
      <SettingField label={t("settings.playback.quality")} htmlFor="playbackQuality" hint={t("settings.playback.qualityHint")}>
        <Select
          id="playbackQuality"
          value={config.playbackQuality}
          onChange={(e) => updateSetting("playbackQuality", e.target.value as QualityPreset)}
        >
          {PLAYBACK_QUALITIES.map((quality) => (
            <option key={quality} value={quality}>
              {quality === "2160p" ? "2160p (4K HEVC)" : quality}
            </option>
          ))}
        </Select>
      </SettingField>

      {/* PLAY-TRACK-01: audio starts in this language when the title has no remembered choice and the file has it. */}
      <SettingField
        label={t("settings.playback.audioLanguage.title")}
        htmlFor="defaultAudioLanguage"
        hint={t("settings.playback.audioLanguage.description")}
      >
        <Select
          id="defaultAudioLanguage"
          value={config.defaultAudioLanguage ?? NO_LANGUAGE}
          onChange={(e) => updateSetting("defaultAudioLanguage", coerceLanguageChoice(e.target.value))}
        >
          <option value={NO_LANGUAGE}>{t("settings.playback.audioLanguage.original")}</option>
          {AUDIO_LANGUAGE_CHOICES.map((code) => (
            <option key={code} value={code}>
              {formatMediaLanguageOptionLabel(code)}
            </option>
          ))}
        </Select>
      </SettingField>

      {/* ACCT-SQUAD-03: subtitles start in this language when the title has no remembered choice and the file has it. */}
      <SettingField
        label={t("subtitleLanguage.title")}
        htmlFor="defaultSubtitleLanguage"
        hint={t("subtitleLanguage.description")}
      >
        <Select
          id="defaultSubtitleLanguage"
          value={config.defaultSubtitleLanguage ?? NO_LANGUAGE}
          onChange={(e) => updateSetting("defaultSubtitleLanguage", coerceLanguageChoice(e.target.value))}
        >
          <option value={NO_LANGUAGE}>{t("subtitleLanguage.none")}</option>
          {AUDIO_LANGUAGE_CHOICES.map((code) => (
            <option key={code} value={code}>
              {formatMediaLanguageOptionLabel(code)}
            </option>
          ))}
        </Select>
      </SettingField>

      <SettingGroup>
        <SettingRow
          htmlFor="forcePlaybackQuality"
          title={t("settings.playback.forceQuality.title")}
          description={t("settings.playback.forceQuality.subtitle")}
          control={
            <Switch
              id="forcePlaybackQuality"
              checked={config.forcePlaybackQuality}
              onCheckedChange={(checked) => updateSetting("forcePlaybackQuality", checked)}
            />
          }
        />
        <SettingRow
          htmlFor="autoplayNextEpisode"
          title={t("settings.playback.autoplay.title")}
          description={t("settings.playback.autoplay.subtitle")}
          control={
            <Switch
              id="autoplayNextEpisode"
              checked={config.autoplayNextEpisode}
              onCheckedChange={(checked) => updateSetting("autoplayNextEpisode", checked)}
            />
          }
        />
        <SettingRow
          htmlFor="introSkipEnabled"
          title={t("settings.playback.intro.title")}
          description={t("settings.playback.intro.subtitle")}
          control={
            <Switch
              id="introSkipEnabled"
              checked={config.introSkipEnabled}
              onCheckedChange={(checked) => updateSetting("introSkipEnabled", checked)}
            />
          }
        />
        <SettingRow
          htmlFor="creditsSkipEnabled"
          title={t("settings.playback.credits.title")}
          description={t("settings.playback.credits.subtitle")}
          control={
            <Switch
              id="creditsSkipEnabled"
              checked={config.creditsSkipEnabled}
              onCheckedChange={(checked) => updateSetting("creditsSkipEnabled", checked)}
            />
          }
        />
      </SettingGroup>
    </div>
  );
}
