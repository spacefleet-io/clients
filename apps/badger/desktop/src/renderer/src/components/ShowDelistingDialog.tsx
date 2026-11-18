import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@space/ui";
import type { ShowEpisodeNotListed } from "@/lib/libraryDb";

export type ShowDelistingDialogProps = {
  showTitle: string;
  episodes: ShowEpisodeNotListed[];
  busy: boolean;
  onRemove: () => void;
  onKeep: () => void;
};

const pad = (n: number) => String(n).padStart(2, "0");

const episodeLabel = (episode: ShowEpisodeNotListed) => {
  const code = `S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)}`;
  return episode.title ? `${code} · ${episode.title}` : code;
};

/**
 * LIB-SHOW-02: asks the user whether to remove the episodes the catalog stopped
 * listing. Only episodes without a file ever reach it; nothing changes until
 * the user clicks Remove. Closing the dialog counts as keeping them.
 */
export default function ShowDelistingDialog({ showTitle, episodes, busy, onRemove, onKeep }: ShowDelistingDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onKeep();
      }}
    >
      <DialogContent data-testid="show-delisting-dialog">
        <DialogHeader>
          <DialogTitle>{t("library.showDelisting.title")}</DialogTitle>
          <DialogDescription>{t("library.showDelisting.description", { show: showTitle })}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
          {episodes.map((episode) => (
            <li key={episode.id}>{episodeLabel(episode)}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("library.showDelisting.filesNote")}</p>
        <DialogFooter>
          <Button variant="outline" data-testid="show-delisting-keep" disabled={busy} onClick={onKeep}>
            {t("library.showDelisting.keep")}
          </Button>
          <Button variant="destructive" data-testid="show-delisting-remove" disabled={busy} onClick={onRemove}>
            {busy ? t("library.showDelisting.removing") : t("library.showDelisting.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
