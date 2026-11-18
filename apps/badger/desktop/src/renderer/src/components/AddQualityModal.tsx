import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@space/ui";
import { Loader2 } from "lucide-react";
import { ESTIMATE_MB_BYTES, mediaSizeLabel } from "@/lib/sizeLabel";
import {
  pickReTranscodeSource,
  QUALITY_ORDER,
  defaultCodecForQuality,
  type QualityPreset,
} from "../../../shared/quality";
import {
  estimateBitrateKbps,
  estimateFromFile,
  estimateFromSourceFormat,
  qualityRank,
} from "@/lib/labJobs";
import type { MediaFormat } from "@/lib/libraryDb";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaId: string;
  fileId: string;
  existingFormats: MediaFormat[];
  durationSeconds: number | null;
};

const KNOWN_PRESETS = new Set<QualityPreset>(QUALITY_ORDER);

const KNOWN_ERROR_CODES = new Set([
  "source-protected",
  "quality-exists",
  "cannot-transcode-up",
  "media-not-found",
]);

const errorReason = (
  t: (key: string, options?: Record<string, unknown>) => string,
  code?: string | null,
): string =>
  code && KNOWN_ERROR_CODES.has(code)
    ? t(`library.qualities.errors.${code}`)
    : code ?? t("library.qualities.errors.media-not-found");

export default function AddQualityModal({
  open,
  onOpenChange,
  mediaId,
  fileId,
  existingFormats,
  durationSeconds,
}: Props) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<Set<QualityPreset>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const existingQualities = useMemo<QualityPreset[]>(
    () =>
      existingFormats
        .map((format) => format.quality)
        .filter((quality): quality is QualityPreset => KNOWN_PRESETS.has(quality as QualityPreset)),
    [existingFormats],
  );

  // Prefer the source format — its actual size + quality let us run the
  // pixel-ratio estimator (audio cost stays constant, video bitrate scales
  // with target resolution). Falls back to the highest-ranked format when
  // isSource is absent (older op-stream payloads).
  const sourceFormat = useMemo<MediaFormat | null>(() => {
    const explicitSource = existingFormats.find((f) => f.isSource === true);
    if (explicitSource) return explicitSource;
    const ranked = [...existingFormats].sort(
      (a, b) => qualityRank(a.quality) - qualityRank(b.quality),
    )[0];
    return ranked ?? null;
  }, [existingFormats]);

  const sourceSizeMb = useMemo<number | null>(() => {
    if (!sourceFormat) return null;
    const size = sourceFormat.sizeMb;
    return Number.isFinite(size) && size > 0 ? size : null;
  }, [sourceFormat]);

  // Candidates: any preset NOT already present AND for which a source variant
  // exists. `pickReTranscodeSource` returning null means cannot-transcode-up,
  // so the UI hides those rows (matches the handler's validation).
  const candidates = useMemo(() => {
    return QUALITY_ORDER
      .filter((preset) => !existingQualities.includes(preset))
      .map((preset) => ({
        preset,
        source: pickReTranscodeSource(preset, existingQualities),
      }))
      .filter((entry): entry is { preset: QualityPreset; source: QualityPreset } =>
        entry.source !== null,
      );
  }, [existingQualities]);

  const estimateSizeForPreset = (preset: QualityPreset): string | null => {
    const codec = defaultCodecForQuality(preset);
    // Best path: pixel-ratio estimator (needs source size + quality + duration).
    // Produces realistic numbers for both low-bitrate sources (small targets
    // shrink correctly because audio is treated as constant) and high-bitrate
    // remuxes (capped by the static "good quality" ceiling per resolution).
    const pixelRatio = estimateFromSourceFormat({
      sourceSizeMb,
      sourceQuality: sourceFormat?.quality ?? null,
      targetQuality: preset,
      targetCodec: codec,
      durationSeconds,
      mediaType: "movie",
    });
    if (pixelRatio !== null) return mediaSizeLabel(pixelRatio * ESTIMATE_MB_BYTES, i18n.language);
    // Fallback 1: file-size ratio when we have source size but no quality
    // or duration. Still better than the static-bitrate ladder because it
    // adapts to the actual source.
    if (sourceSizeMb !== null) {
      const sizeMb = estimateFromFile(sourceSizeMb, preset, codec, "movie");
      if (Number.isFinite(sizeMb) && sizeMb > 0) return mediaSizeLabel(sizeMb * ESTIMATE_MB_BYTES, i18n.language);
    }
    // Fallback 2: static bitrate × duration when we only have duration.
    if (!durationSeconds || durationSeconds <= 0) return null;
    const bitrateKbps = estimateBitrateKbps(preset, codec);
    const sizeMb = (bitrateKbps * durationSeconds) / 8 / 1024;
    if (!Number.isFinite(sizeMb) || sizeMb <= 0) return null;
    return mediaSizeLabel(sizeMb * ESTIMATE_MB_BYTES, i18n.language);
  };

  const handleClose = (next: boolean) => {
    if (submitting) return;
    if (!next) setSelected(new Set());
    onOpenChange(next);
  };

  const toggle = (preset: QualityPreset) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(preset)) next.delete(preset);
      else next.add(preset);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0 || submitting) return;
    const api = window.sf?.runtimeJobs?.replanQualities;
    if (!api) {
      toast(
        t("library.qualities.addModalFailedToast", {
          reason: t("library.qualities.errors.media-not-found"),
        }),
      );
      return;
    }
    setSubmitting(true);
    try {
      const result = await api({
        mediaId,
        fileId,
        addQualities: Array.from(selected),
        removeFormatIds: [],
      });
      if ("__runtimeJobsError" in result) {
        toast(
          t("library.qualities.addModalFailedToast", {
            reason: result.message ?? result.errorCode ?? "",
          }),
        );
        return;
      }
      if (result.errorCode) {
        toast(
          t("library.qualities.addModalFailedToast", {
            reason: errorReason(t, result.errorCode),
          }),
        );
        return;
      }
      toast(
        t("library.qualities.addModalSubmittedToast", { count: result.addedJobIds.length }),
      );
      setSelected(new Set());
      onOpenChange(false);
    } catch (err) {
      toast(
        t("library.qualities.addModalFailedToast", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("library.qualities.addModalTitle")}</DialogTitle>
          <DialogDescription>{t("library.qualities.addModalDescription")}</DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t("library.qualities.addModalEmpty")}
          </div>
        ) : (
          <div className="space-y-1">
            {candidates.map(({ preset, source }) => {
              const checked = selected.has(preset);
              const sizeLabel = estimateSizeForPreset(preset);
              return (
                <label
                  key={preset}
                  className={[
                    "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition",
                    checked
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={checked}
                      onChange={() => toggle(preset)}
                      disabled={submitting}
                    />
                    <span className="text-sm font-semibold">{preset}</span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
                    <span>{t("library.qualities.addModalSource", { quality: source })}</span>
                    <span>
                      {sizeLabel
                        ? t("library.qualities.addModalSize", { size: sizeLabel })
                        : t("library.qualities.addModalSizeUnknown")}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>
            {t("library.qualities.addModalCancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={selected.size === 0 || submitting || candidates.length === 0}
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("library.qualities.addModalConfirm", { count: selected.size })}
              </span>
            ) : (
              t("library.qualities.addModalConfirm", { count: selected.size })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
