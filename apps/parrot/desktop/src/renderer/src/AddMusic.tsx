import { useState } from "react";
import { Upload } from "lucide-react";
import { ImportReviewDialog, ImportReviewPicker, Spinner } from "@space/ui";
import type { ParrotImportStatus } from "../../shared/ipc";
import type { Translate } from "./i18n";

type Props = {
  t: Translate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The scan started: the import line and the confirm dialog (PAR-UP-05) take over from here. */
  onScanned: (status: ParrotImportStatus) => void;
};

/**
 * What the top bar's "+" opens (UX-ADD-01, PAR-NAV-01): Badger's add-media dialog, offering to choose song files or a
 * folder. What was picked is read by the same scan as a folder, so the confirm dialog (PAR-UP-05) shows next.
 */
export default function AddMusic({ t, open, onOpenChange, onScanned }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async (kind: "file" | "folder") => {
    setError(null);
    const paths = kind === "file" ? await window.parrot.pickFiles() : await window.parrot.pickFolders();
    console.info(`[parrot:add-music] picked ${kind}`, paths.length);
    if (paths.length === 0) return;
    setBusy(true);
    try {
      const status = await window.parrot.scanImport(paths);
      onScanned(status);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImportReviewDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={t("addMusic.title")}
      data-testid="add-music-dialog"
    >
      <ImportReviewPicker
        icon={<Upload className="h-10 w-10 text-muted-foreground" aria-hidden />}
        title={t("addMusic.emptyTitle")}
        subtitle={t("addMusic.emptySubtitle")}
        error={error}
        browseFilesLabel={t("addMusic.browseFiles")}
        browseFoldersLabel={t("addMusic.browseFolders")}
        onBrowse={(kind) => void browse(kind)}
        busy={
          busy ? (
            <>
              <Spinner size="sm" />
              {t("import.scanning")}
            </>
          ) : undefined
        }
      />
    </ImportReviewDialog>
  );
}
