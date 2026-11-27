import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@space/ui";
import { ESTIMATE_MB_BYTES, mediaSizeLabel } from "@/lib/sizeLabel";

type VideoDecisionItem = {
  title: string;
  slotLabel: string;
  quality: string;
  estimatedSizeMb: number | null;
  existingQualities: string[];
};

type FileIngestionResolveVideoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeItem: VideoDecisionItem | null;
  resolveIndex: number;
  totalCount: number;
  onBack: () => void;
  onSkip: () => void;
  onAdd: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** The interface language: the estimate is written in it (STOR-UNIT-02). */
  language: string;
};

export default function FileIngestionResolveVideoDialog({
  open,
  onOpenChange,
  activeItem,
  resolveIndex,
  totalCount,
  onBack,
  onSkip,
  onAdd,
  t,
  language,
}: FileIngestionResolveVideoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-xl p-6">
        <DialogHeader>
          <DialogTitle>{t("ingestion.ui.resolveVideoTitle")}</DialogTitle>
        </DialogHeader>
        {activeItem ? (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              {t("ingestion.ui.resolveVideoProgress", { current: Math.min(resolveIndex + 1, totalCount), total: totalCount })}
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
              <div className="text-sm font-semibold text-foreground">{activeItem.title}</div>
              <div className="text-xs text-muted-foreground">{activeItem.slotLabel}</div>
              <div className="text-sm">
                {t("ingestion.ui.addQualityQuestion", { quality: activeItem.quality })}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("ingestion.ui.estimatedExtraStorage")}{" "}
                {activeItem.estimatedSizeMb !== null
                  ? `+${mediaSizeLabel(activeItem.estimatedSizeMb * ESTIMATE_MB_BYTES, language)}`
                  : t("ingestion.ui.unknown")}
              </div>
              {activeItem.existingQualities.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t("ingestion.ui.alreadyAvailable")}: {activeItem.existingQualities.join(", ")}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={onBack} disabled={resolveIndex === 0}>
                {t("ingestion.ui.back")}
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onSkip}>
                  {t("ingestion.ui.skipQuality")}
                </Button>
                <Button onClick={onAdd}>{t("ingestion.ui.addQuality")}</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("ingestion.ui.noVideoDecisions")}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
