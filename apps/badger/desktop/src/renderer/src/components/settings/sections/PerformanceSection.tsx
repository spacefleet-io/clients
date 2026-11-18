import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@space/ui";
import { formatEncoderLabel } from "@/lib/ffmpegCapabilities";
import { useFfmpegCapabilities } from "@/lib/settings/useFfmpegCapabilities";
import { SettingHint, SettingPanel } from "../kit";

export default function PerformanceSection() {
  const { t } = useTranslation();
  const ffmpeg = useFfmpegCapabilities();
  const caps = ffmpeg.caps;

  return (
    <div className="space-y-4">
      {/* GPU / ffmpeg diagnostics */}
      <SettingPanel>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="font-semibold">{t("settings.advanced.gpu.title")}</div>
            <SettingHint>{t("settings.advanced.gpu.subtitle")}</SettingHint>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={ffmpeg.runTest}
              disabled={ffmpeg.capsLoading || ffmpeg.testLoading || !ffmpeg.canTest}
            >
              {ffmpeg.testLoading ? t("settings.advanced.gpu.testing") : t("settings.advanced.gpu.runQuickTest")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={ffmpeg.loadDiagnostics}
              disabled={ffmpeg.capsLoading || ffmpeg.diagnosticsLoading || !ffmpeg.canDiagnose}
            >
              {ffmpeg.diagnosticsLoading ? t("settings.advanced.gpu.loading") : t("settings.advanced.gpu.diagnostics")}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.advanced.gpu.ffmpegBinary")}</span>
            <span className="truncate text-foreground">
              {caps?.ffmpegPath ? caps.ffmpegPath : t("settings.advanced.gpu.unknown")}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.advanced.gpu.gpuDetected")}</span>
            <span className="text-foreground">
              {ffmpeg.capsLoading
                ? t("settings.advanced.gpu.checking")
                : caps?.gpu
                  ? [caps.gpu.vendor, caps.gpu.device].filter(Boolean).join(" ")
                  : t("settings.advanced.gpu.notDetected")}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.advanced.gpu.ffmpegEncoders")}</span>
            <span className="text-foreground">
              {ffmpeg.capsLoading
                ? t("settings.advanced.gpu.checking")
                : [
                    caps?.encoders.includes("h264_nvenc") ? "NVENC" : null,
                    caps?.encoders.includes("h264_qsv") ? "Quick Sync" : null,
                    caps?.encoders.includes("h264_vaapi") ? "VAAPI" : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || t("settings.advanced.gpu.cpuOnly")}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.advanced.gpu.preferredPath")}</span>
            <span className="text-foreground">
              {ffmpeg.capsLoading ? t("settings.advanced.gpu.checking") : formatEncoderLabel(caps?.preferredEncoder)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.advanced.gpu.lastTest")}</span>
            <span className="inline-flex items-center gap-2 text-foreground">
              {caps?.lastTest ? (
                caps.lastTest.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-rose-500" />
                )
              ) : null}
              {caps?.lastTest
                ? `${formatEncoderLabel(caps.lastTest.encoder)} · ${
                    caps.lastTest.ok ? t("settings.advanced.gpu.ok") : t("settings.advanced.gpu.failed")
                  }`
                : t("settings.advanced.gpu.notRun")}
            </span>
          </div>
        </div>

        {caps?.lastTest?.message ? (
          <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            {caps.lastTest.message}
          </div>
        ) : null}
        {caps?.lastTest?.logTail ? (
          <details className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">{t("settings.advanced.gpu.testLog")}</summary>
            <pre className="mt-2 whitespace-pre-wrap">{caps.lastTest.logTail}</pre>
          </details>
        ) : null}
        {ffmpeg.showDiagnostics ? (
          <details className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">{t("settings.advanced.gpu.encoderOutput")}</summary>
            <pre className="mt-2 whitespace-pre-wrap">
              {caps?.encoderOutputSample || t("settings.advanced.gpu.noOutput")}
            </pre>
          </details>
        ) : null}
        {ffmpeg.showDiagnostics ? (
          <details className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">{t("settings.advanced.gpu.hwaccelOutput")}</summary>
            <pre className="mt-2 whitespace-pre-wrap">
              {caps?.hwaccelOutputSample || t("settings.advanced.gpu.noOutput")}
            </pre>
          </details>
        ) : null}
      </SettingPanel>
    </div>
  );
}
