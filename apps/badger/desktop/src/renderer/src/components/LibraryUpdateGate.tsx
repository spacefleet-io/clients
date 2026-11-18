import { useState, useSyncExternalStore } from "react";
import { getAppUpdateRequired, onAppUpdateRequired } from "@space/shared/appVersion";
import { useLibraryShell } from "@/lib/libraryContext";
import { useUpdater } from "@/lib/useUpdater";
import LibraryFormatTooNewModal from "@/components/LibraryFormatTooNewModal";
import UpdateAvailableModal from "@/components/UpdateAvailableModal";

/**
 * Mounts the library-format update gate (Part D3).
 *
 * The library is at a format version newer than this build supports (`useLibraryShell().formatTooNew` is non-null):
 * `LibraryFormatTooNewModal` explains it, and its "Update Now" drives the `useUpdater` pipeline (check → download →
 * install) through the non-dismissible `UpdateAvailableModal` — the user has no usable library until they update.
 *
 * A build that is too old for the API (REL-CD-29: refused with "please update", or reported below `minClientVersion` by
 * release-status, the updater's latched `state.mandatory`) is carried by `AppUpdateRequiredGate` above the routes, on
 * every screen; this gate then stays closed so two prompts never stack.
 */
export default function LibraryUpdateGate() {
  const { formatTooNew } = useLibraryShell();
  const updater = useUpdater();
  // Once "Update Now" is clicked on the format modal we hand the user the progress modal.
  const [updateStarted, setUpdateStarted] = useState(false);

  const handleUpdateNow = () => {
    setUpdateStarted(true);
    void updater.runFullUpdate();
  };

  const refused = useSyncExternalStore(onAppUpdateRequired, getAppUpdateRequired) !== null;
  const appGateOpen = refused || updater.state.mandatory;
  const showTooNewModal = formatTooNew !== null && !updateStarted && !appGateOpen;
  const showProgressModal = formatTooNew !== null && updateStarted && !appGateOpen;

  return (
    <>
      <LibraryFormatTooNewModal
        detail={showTooNewModal ? formatTooNew : null}
        onUpdateNow={handleUpdateNow}
        updating={updater.state.phase === "checking"}
      />
      <UpdateAvailableModal
        open={showProgressModal}
        state={updater.state}
        onDownload={() => void updater.download()}
        onRestart={updater.install}
        // No `onDismiss`: the format-too-new path is blocking.
      />
    </>
  );
}
