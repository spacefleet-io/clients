import { Button } from "@space/ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { Check, Loader2, Plus } from "lucide-react";
import { useAppPlaybackMark } from "@space/ui/app-playback-mark";
import { keepTrailerDialogFocus, useCloseTrailerOnPlayerEscape } from "@/lib/trailers";

type PlaylistRow = {
  id: string;
  name: string;
  slug: string | null;
  isSystem: boolean;
};

type MediaDetailsActionDialogsProps = {
  restoreOpen: boolean;
  onRestoreOpenChange: (open: boolean) => void;
  hasCustomCast: boolean;
  restoring: boolean;
  onRestoreKeepCast: () => void;
  onRestoreFull: () => void;
  activeTrailerKey: string | null;
  onActiveTrailerKeyChange: (key: string | null) => void;
  buildTrailerUrl: (key: string) => string;
  deleteTarget: { id: string; title: string } | null;
  deletingMedia: boolean;
  onDeleteTargetChange: (target: { id: string; title: string } | null) => void;
  onConfirmDelete: () => void;
  showPlaylistPicker: boolean;
  onShowPlaylistPickerChange: (open: boolean) => void;
  playlists: PlaylistRow[];
  selectedPlaylistIds: string[];
  playlistLabel: (name: string, slug: string | null) => string;
  onTogglePlaylist: (playlistId: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export default function MediaDetailsActionDialogs({
  restoreOpen,
  onRestoreOpenChange,
  hasCustomCast,
  restoring,
  onRestoreKeepCast,
  onRestoreFull,
  activeTrailerKey,
  onActiveTrailerKeyChange,
  buildTrailerUrl,
  deleteTarget,
  deletingMedia,
  onDeleteTargetChange,
  onConfirmDelete,
  showPlaylistPicker,
  onShowPlaylistPickerChange,
  playlists,
  selectedPlaylistIds,
  playlistLabel,
  onTogglePlaylist,
  t,
}: MediaDetailsActionDialogsProps) {
  // No background shooting star while a trailer plays (UX-SKY-01).
  useAppPlaybackMark(Boolean(activeTrailerKey));
  useCloseTrailerOnPlayerEscape(Boolean(activeTrailerKey), () => onActiveTrailerKeyChange(null));
  const nonFavoritePlaylists = playlists.filter((playlist) => playlist.slug !== "favorites");

  return (
    <>
      <Dialog open={restoreOpen} onOpenChange={onRestoreOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("library.edit.restoreTitle")}</DialogTitle>
            <DialogDescription>
              {hasCustomCast ? t("library.edit.restoreDescriptionCast") : t("library.edit.restoreDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => onRestoreOpenChange(false)}>
              {t("library.edit.cancel")}
            </Button>
            {hasCustomCast ? (
              <>
                <Button type="button" variant="outline" onClick={onRestoreKeepCast} disabled={restoring}>
                  {t("library.edit.restoreKeepCast")}
                </Button>
                <Button type="button" variant="destructive" onClick={onRestoreFull} disabled={restoring}>
                  {t("library.edit.restoreFull")}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={onRestoreFull} disabled={restoring}>
                {t("library.edit.restoreFull")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(activeTrailerKey)}
        onOpenChange={(open) => {
          if (!open) onActiveTrailerKeyChange(null);
        }}
      >
        <DialogContent className="max-w-4xl" onOpenAutoFocus={keepTrailerDialogFocus}>
          <DialogHeader>
            <DialogTitle>{t("library.trailer")}</DialogTitle>
          </DialogHeader>
          {activeTrailerKey ? (
            <div className="aspect-video overflow-hidden rounded-xl border border-border bg-muted">
              <iframe
                title={t("library.trailer")}
                src={buildTrailerUrl(activeTrailerKey)}
                className="h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && !deletingMedia && onDeleteTargetChange(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("library.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {deleteTarget ? t("library.deleteConfirm", { title: deleteTarget.title }) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => onDeleteTargetChange(null)} disabled={deletingMedia}>
              {t("library.deleteCancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmDelete} disabled={deletingMedia}>
              {deletingMedia ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("library.deleting")}
                </span>
              ) : (
                t("library.delete")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPlaylistPicker} onOpenChange={onShowPlaylistPickerChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("library.playlists.add")}</DialogTitle>
            <DialogDescription>{t("playlists.manageSubtitle")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {nonFavoritePlaylists.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("library.playlists.empty")}</div>
            ) : (
              nonFavoritePlaylists.map((playlist) => {
                const isIn = selectedPlaylistIds.includes(playlist.id);
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    className={[
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition",
                      isIn
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/40 hover:bg-muted/30",
                    ].join(" ")}
                    onClick={() => onTogglePlaylist(playlist.id)}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{playlistLabel(playlist.name, playlist.slug)}</div>
                      {playlist.isSystem ? (
                        <div className="text-xs text-muted-foreground">{t("library.playlists.system")}</div>
                      ) : null}
                    </div>
                    <span className="text-muted-foreground">
                      {isIn ? <Check className="h-4 w-4 text-primary" /> : <Plus className="h-4 w-4" />}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onShowPlaylistPickerChange(false)}>
              {t("library.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
