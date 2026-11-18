import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";

type DeleteTarget = { id: string; title: string } | null;

type LibraryDeleteDialogProps = {
  deleteTarget: DeleteTarget;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
};

export default function LibraryDeleteDialog({
  deleteTarget,
  isDeleting,
  onClose,
  onConfirm,
}: LibraryDeleteDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md border border-[#30363d] bg-[#161b22] text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle>{t("library.deleteTitle")}</DialogTitle>
          <DialogDescription className="text-[#8b949e]">
            {deleteTarget ? t("library.deleteConfirm", { title: deleteTarget.title }) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="secondary"
            className="border border-[#30363d] bg-[#0f141b] text-white"
            onClick={onClose}
            disabled={isDeleting}
          >
            {t("library.deleteCancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void onConfirm()}
            className="bg-[#ff7b72] text-[#0d1117] hover:bg-[#ff6a60]"
            disabled={isDeleting}
          >
            {isDeleting ? t("library.deleting") : t("library.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
