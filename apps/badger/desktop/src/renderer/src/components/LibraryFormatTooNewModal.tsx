import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@space/ui";
import type { LibraryFormatTooNewDetail } from "@/lib/libraryContext";

type LibraryFormatTooNewModalProps = {
  /**
   * The parsed too-new detail, or `null` when the library is compatible. The
   * modal is open exactly when this is non-null — it is intentionally
   * non-dismissible: a too-old client cannot safely read the library, so
   * there is no "continue anyway" path.
   */
  detail: LibraryFormatTooNewDetail | null;
  /**
   * Invoked when the user clicks "Update Now". Wired to the Part E updater
   * pipeline (`check → download → install`). The caller owns the actual
   * update sequence; this modal only surfaces the CTA.
   */
  onUpdateNow: () => void;
  /**
   * True while the updater pipeline is running after "Update Now" was
   * clicked — disables the button and shows a spinner so the user gets
   * feedback during the download.
   */
  updating?: boolean;
};

/**
 * Blocking modal shown when the local or remote library is at a format version
 * newer than this build of Badger Desktop supports (Part D3). It is the single
 * UI surface for a `LibraryFormatTooNewError` from any of the three versioned
 * library surfaces — storage format, op-stream, or per-group schema.
 *
 * The modal has no close affordance and no overlay-dismiss: the library is
 * genuinely unreadable by this build, so the only forward path is updating the
 * app. "Update Now" drives the in-app updater (Part E).
 */
export default function LibraryFormatTooNewModal({
  detail,
  onUpdateNow,
  updating = false,
}: LibraryFormatTooNewModalProps) {
  const { t } = useTranslation();
  const open = detail !== null;

  return (
    <Dialog open={open}>
      {/*
        `onPointerDownOutside` / `onEscapeKeyDown` are prevented so the modal
        cannot be dismissed — there is no usable app behind it until the user
        updates. The Radix `DialogClose` X is hidden via the `[&>button]` rule.
      */}
      <DialogContent
        className="sm:max-w-md border border-[#30363d] bg-[#161b22] text-white shadow-2xl [&>button[aria-label]]:hidden [&>button:last-of-type]:hidden"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#bb800926]">
            <AlertTriangle className="h-6 w-6 text-[#d29922]" aria-hidden />
          </div>
          <DialogTitle>{t("libraryFormat.tooNew.title")}</DialogTitle>
          <DialogDescription className="text-[#8b949e]">
            {t("libraryFormat.tooNew.body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="default"
            className="bg-[#238636] text-white hover:bg-[#2ea043]"
            onClick={onUpdateNow}
            pending={updating}
            spinnerLabel={t("libraryFormat.tooNew.updating")}
          >
            {t("libraryFormat.tooNew.updateNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
