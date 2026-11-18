import { useTranslation } from "react-i18next";
import { Checkbox, Select, Switch } from "@space/ui";
import {
  defaultCodecForQuality,
  type CodecPreset,
  type QualityPreset,
  type TranscodeOutput,
} from "@/lib/config";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { useDeviceFallbackCopy } from "@/lib/deviceTranscode";
import { useDeviceUploadsDuringPlayback } from "@/lib/deviceUploadsDuringPlayback";
import { UPLOADS_DURING_PLAYBACK_VALUES, isUploadsDuringPlayback } from "../../../../../shared/uploadPlaybackDefault";
import { SettingGroup, SettingHint, SettingPanel, SettingRow } from "../kit";

// No 360p (or 480p) here: the one fallback 360p copy is decided per computer (toggle
// below, main/deviceSettings.ts); an account-level 360p/480p entry is ignored at ingest.
const TRANSCODE_QUALITIES: QualityPreset[] = ["2160p", "1080p", "720p", "240p", "144p"];

const hasOutput = (outputs: TranscodeOutput[], quality: QualityPreset, codec: CodecPreset) =>
  outputs.some((o) => o.quality === quality && o.codec === codec);

const toggleOutputCodec = (
  outputs: TranscodeOutput[],
  quality: QualityPreset,
  codec: CodecPreset,
  enabled: boolean
): TranscodeOutput[] => {
  const exists = hasOutput(outputs, quality, codec);
  if (enabled && !exists) return [...outputs, { quality, codec }];
  if (!enabled && exists) return outputs.filter((o) => !(o.quality === quality && o.codec === codec));
  return outputs;
};

const removeQualityOutputs = (outputs: TranscodeOutput[], quality: QualityPreset) =>
  outputs.filter((o) => o.quality !== quality);

export default function TranscodingSection() {
  const { t } = useTranslation();
  const { config, updateSetting, updateNestedSetting } = useClientSettings();
  // undefined = no device-settings bridge (web/tests) → row hidden; null = loading.
  const { value: deviceFallbackCopy, set: setDeviceFallbackCopy } = useDeviceFallbackCopy("settings");
  // Same idea for "uploads while a video plays": undefined = hidden, null = loading.
  const { value: uploadsDuringPlayback, set: setUploadsDuringPlayback } = useDeviceUploadsDuringPlayback("settings");

  const isQualityEnabled = (quality: QualityPreset) =>
    config.transcodeOutputs.some((o) => o.quality === quality);
  const isCodecEnabled = (quality: QualityPreset, codec: CodecPreset) =>
    hasOutput(config.transcodeOutputs, quality, codec);

  const toggleOutputQualitySimple = (quality: QualityPreset, enabled: boolean) => {
    const currentlyEnabled = config.transcodeOutputs.some((o) => o.quality === quality);
    if (enabled === currentlyEnabled) return;
    let nextOutputs = config.transcodeOutputs;
    if (!enabled) {
      nextOutputs = removeQualityOutputs(nextOutputs, quality);
    } else {
      const codec = defaultCodecForQuality(quality);
      const withoutQuality = removeQualityOutputs(nextOutputs, quality);
      nextOutputs = [...withoutQuality, { quality, codec }];
    }
    updateNestedSetting({ transcodeOutputs: nextOutputs });
  };

  const toggleOutputQualityCodec = (quality: QualityPreset, codec: CodecPreset, enabled: boolean) => {
    if (quality === "2160p" && codec === "h264") return;
    updateNestedSetting({
      transcodeOutputs: toggleOutputCodec(config.transcodeOutputs, quality, codec, enabled),
    });
  };

  return (
    <div className="space-y-4">
      {/* Codec selection toggle — now co-located with the matrix it controls. */}
      <SettingGroup>
        <SettingRow
          title={t("settings.video.codecSelection")}
          description={t("settings.video.codecSelectionHint")}
          control={
            <Switch
              checked={config.enableCodecSelection}
              onCheckedChange={(checked) => updateSetting("enableCodecSelection", checked)}
            />
          }
        />
      </SettingGroup>

      {/* #25: this computer's fallback 360p copy (device-local, not the account ladder). */}
      {deviceFallbackCopy !== undefined ? (
        <SettingGroup>
          <SettingRow
            title={t("settings.video.fallbackCopy.title")}
            description={t("settings.video.fallbackCopy.subtitle")}
            control={
              <Switch
                data-testid="settings-fallback-copy-switch"
                checked={deviceFallbackCopy === true}
                disabled={deviceFallbackCopy === null}
                onCheckedChange={setDeviceFallbackCopy}
              />
            }
          />
        </SettingGroup>
      ) : null}

      {/* #25: what uploads do while a video plays on this computer (full / throttle / pause). */}
      {uploadsDuringPlayback !== undefined ? (
        <SettingGroup>
          <SettingRow
            htmlFor="uploadsDuringPlayback"
            title={t("settings.video.uploadsDuringPlayback.title")}
            description={
              <>
                {t("settings.video.uploadsDuringPlayback.subtitle")}
                {uploadsDuringPlayback ? (
                  <span className="mt-1 block" data-testid="settings-uploads-playback-hint">
                    {t(`settings.video.uploadsDuringPlayback.hint.${uploadsDuringPlayback}`)}
                  </span>
                ) : null}
              </>
            }
            control={
              <Select
                id="uploadsDuringPlayback"
                data-testid="settings-uploads-playback-select"
                className="min-w-36"
                value={uploadsDuringPlayback ?? ""}
                disabled={uploadsDuringPlayback === null}
                onChange={(e) => {
                  if (isUploadsDuringPlayback(e.target.value)) setUploadsDuringPlayback(e.target.value);
                }}
              >
                {UPLOADS_DURING_PLAYBACK_VALUES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`settings.video.uploadsDuringPlayback.options.${mode}`)}
                  </option>
                ))}
              </Select>
            }
          />
        </SettingGroup>
      ) : null}

      {/* Transcode outputs */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("settings.video.outputsTitle")}</div>
          <SettingHint>{t("settings.video.outputsSubtitle")}</SettingHint>
        </div>

        <div className="mt-4 space-y-3">
          {!config.enableCodecSelection ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {TRANSCODE_QUALITIES.map((quality) => {
                  const enabled = isQualityEnabled(quality);
                  return (
                    <button
                      key={quality}
                      type="button"
                      onClick={() => toggleOutputQualitySimple(quality, !enabled)}
                      className={[
                        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
                        enabled
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                      ].join(" ")}
                    >
                      <span className="font-medium">{quality}</span>
                    </button>
                  );
                })}
              </div>
              <SettingHint>{t("settings.video.codecAutoHint")}</SettingHint>
            </>
          ) : (
            <div className="space-y-2">
              {TRANSCODE_QUALITIES.map((quality) => {
                const h264Allowed = quality !== "2160p";
                const h264Enabled = h264Allowed && isCodecEnabled(quality, "h264");
                const hevcEnabled = isCodecEnabled(quality, "hevc");
                const qualityEnabled = h264Enabled || hevcEnabled;
                return (
                  <div
                    key={quality}
                    className={[
                      "flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/10 px-3 py-2",
                      qualityEnabled ? "" : "opacity-60",
                    ].join(" ")}
                  >
                    <div className="text-xs font-medium">{quality}</div>
                    <div className="flex items-center gap-4">
                      <label className={["flex items-center gap-2 text-xs", h264Allowed ? "" : "opacity-50"].join(" ")}>
                        <Checkbox
                          checked={h264Enabled}
                          disabled={!h264Allowed}
                          onCheckedChange={(checked) => toggleOutputQualityCodec(quality, "h264", Boolean(checked))}
                        />
                        <span>{t("settings.video.codecH264")}</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={hevcEnabled}
                          onCheckedChange={(checked) => toggleOutputQualityCodec(quality, "hevc", Boolean(checked))}
                        />
                        <span>{t("settings.video.codecHevc")}</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SettingPanel>

      {/* Parallelism */}
      <SettingGroup>
        <SettingRow
          htmlFor="maxParallelTranscodes"
          title={t("settings.video.maxParallelTranscodes.title")}
          description={t("settings.video.maxParallelTranscodes.subtitle")}
          control={
            <Select
              id="maxParallelTranscodes"
              className="min-w-36"
              value={String(config.maxParallelTranscodes)}
              onChange={(e) => updateSetting("maxParallelTranscodes", Number(e.target.value))}
            >
              <option value="1">{t("settings.video.maxParallelTranscodes.options.1")}</option>
              <option value="2">{t("settings.video.maxParallelTranscodes.options.2")}</option>
              <option value="3">{t("settings.video.maxParallelTranscodes.options.3")}</option>
            </Select>
          }
        />
        <SettingRow
          htmlFor="maxParallelExtractions"
          title={t("settings.video.maxParallelExtractions.title")}
          description={t("settings.video.maxParallelExtractions.subtitle")}
          control={
            <Select
              id="maxParallelExtractions"
              className="min-w-36"
              value={String(config.maxParallelExtractions)}
              onChange={(e) => updateSetting("maxParallelExtractions", Number(e.target.value))}
            >
              <option value="1">{t("settings.video.maxParallelExtractions.options.1")}</option>
              <option value="2">{t("settings.video.maxParallelExtractions.options.2")}</option>
              <option value="3">{t("settings.video.maxParallelExtractions.options.3")}</option>
            </Select>
          }
        />
      </SettingGroup>
    </div>
  );
}
