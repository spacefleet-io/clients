import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@space/ui";
import type { UpdaterState } from "@/lib/useUpdater";

type UpdateAvailableModalProps = {
  /** Whether the modal is shown. The caller decides (e.g. an optional update). */
  open: boolean;
  /** Current updater lifecycle state from `useUpdater`. */
  state: UpdaterState;
  /** Start the download. */
  onDownload: () => void;
  /** Quit + install the downloaded update + relaunch. */
  onRestart: () => void;
  /**
   * Dismiss the modal. Only wired for an *optional* update — a mandatory
   * update (library format gate) passes `undefined` so the modal is blocking.
   */
  onDismiss?: () => void;
};

/**
 * Update progress modal (Part E4): shown for an optional update that the user
 * chose to act on, or as the progress surface a mandatory update advances
 * through. Renders download progress and a "Restart now" CTA once the update
 * has finished downloading.
 *
 * When `onDismiss` is omitted the modal is non-dismissible — that is how the
 * mandatory `LibraryFormatTooNewModal` path reuses it.
 */
export default function UpdateAvailableModal({
  open,
  state,
  onDownload,
  onRestart,
  onDismiss,
}: UpdateAvailableModalProps) {
  const { t } = useTranslation();
  const dismissible = typeof onDismiss === "function";
  // A copy from SpaceFleet's .deb/.rpm/.pacman packages installs through the package manager (REL-UPD-07): its
  // `installing`/`installed` read like the download's progress and finish, and "Restart now" relaunches it.
  const downloading = state.phase === "downloading" || state.phase === "installing";
  const downloaded = state.phase === "downloaded" || state.phase === "installed";
  const failed = state.phase === "error";

  const body = downloaded
    ? state.version
      ? t("updater.available.body", { version: state.version })
      : t("updater.available.bodyCurrent")
    : downloading
      ? t("updater.available.downloading", { percent: state.progress })
      : failed
        ? t("updater.available.failed")
        : state.version
          ? t("updater.available.body", { version: state.version })
          : t("updater.available.bodyCurrent");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onDismiss?.();
      }}
    >
      <DialogContent
        className={`sm:max-w-md border border-[#30363d] bg-[#161b22] text-white shadow-2xl ${
          dismissible ? "" : "[&>button:last-of-type]:hidden"
        }`}
        onPointerDownOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#1f6feb26]">
            <Download className="h-6 w-6 text-[#58a6ff]" aria-hidden />
          </div>
          <DialogTitle>{t("updater.available.title")}</DialogTitle>
          <DialogDescription className="text-[#8b949e]">{body}</DialogDescription>
        </DialogHeader>

        {downloading ? (
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[#21262d]"
            role="progressbar"
            aria-valuenow={state.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-[#1f6feb] transition-[width] duration-200"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          {dismissible && !downloaded ? (
            <Button
              type="button"
              variant="secondary"
              className="border border-[#30363d] bg-[#0f141b] text-white"
              onClick={onDismiss}
              disabled={downloading}
            >
              {t("updater.available.later")}
            </Button>
          ) : null}
          {downloaded ? (
            <Button
              type="button"
              variant="default"
              className="bg-[#238636] text-white hover:bg-[#2ea043]"
              onClick={onRestart}
            >
              {t("updater.available.restart")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              className="bg-[#1f6feb] text-white hover:bg-[#388bfd]"
              onClick={onDownload}
              pending={downloading}
              spinnerLabel={t("updater.available.downloading", { percent: state.progress })}
            >
              {failed ? t("updater.check") : t("updater.available.download")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
