import { Check, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@space/ui";
import { useAppPlaybackMark } from "@space/ui/app-playback-mark";

import type { Trailer } from "@/api";
import { keepTrailerDialogFocus, useCloseTrailerOnPlayerEscape } from "@/lib/trailers";

type TrailerEntry = {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  trailers: Trailer[];
};

type FileIngestionTrailerDialogsProps = {
  activeTrailerKey: string | null;
  onActiveTrailerKeyChange: (key: string | null) => void;
  openTrailerId: string | null;
  onOpenTrailerIdChange: (id: string | null) => void;
  trailerCache: Record<string, TrailerEntry>;
  buildTrailerUrl: (key: string) => string;
  onSelectTrailer: (key: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export default function FileIngestionTrailerDialogs({
  activeTrailerKey,
  onActiveTrailerKeyChange,
  openTrailerId,
  onOpenTrailerIdChange,
  trailerCache,
  buildTrailerUrl,
  onSelectTrailer,
  t,
}: FileIngestionTrailerDialogsProps) {
  // No background shooting star while a trailer plays (UX-SKY-01).
  useAppPlaybackMark(Boolean(activeTrailerKey));
  useCloseTrailerOnPlayerEscape(Boolean(activeTrailerKey), () => onActiveTrailerKeyChange(null));
  return (
    <>
      <Dialog
        open={Boolean(activeTrailerKey)}
        onOpenChange={(openValue) => {
          if (!openValue) onActiveTrailerKeyChange(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="max-w-4xl p-0 overflow-hidden"
          onOpenAutoFocus={keepTrailerDialogFocus}
        >
          {activeTrailerKey ? (
            <iframe
              className="aspect-video w-full"
              src={buildTrailerUrl(activeTrailerKey)}
              title={t("ingestion.ui.trailer")}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(openTrailerId)}
        onOpenChange={(openValue) => {
          if (!openValue) onOpenTrailerIdChange(null);
        }}
      >
        <DialogContent aria-describedby={undefined} className="max-w-md p-0 overflow-hidden">
          <div className="p-4 border-b border-border">
            <DialogTitle>{t("ingestion.ui.chooseTrailer")}</DialogTitle>
          </div>
          <div className="p-4">
            {openTrailerId ? (
              trailerCache[openTrailerId]?.status === "loading" ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("ingestion.ui.loadingTrailers")}
                </div>
              ) : (trailerCache[openTrailerId]?.trailers?.length ?? 0) === 0 ? (
                <div className="text-xs text-muted-foreground">{t("ingestion.ui.noTrailers")}</div>
              ) : (
                <div className="space-y-2">
                  {(trailerCache[openTrailerId]?.trailers ?? []).map((trailer) => (
                    <button
                      key={`${trailer.language}-${trailer.key}`}
                      className="flex w-full items-center justify-between rounded-md border border-border/60 px-3 py-2 text-left text-sm hover:bg-muted/40"
                      onClick={() => onSelectTrailer(trailer.key)}
                    >
                      <span className="truncate">
                        {trailer.language.toUpperCase()}
                        {trailer.name ? ` · ${trailer.name}` : ""}
                      </span>
                      {trailer.official ? <Check className="h-3 w-3 text-emerald-500" /> : null}
                    </button>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
