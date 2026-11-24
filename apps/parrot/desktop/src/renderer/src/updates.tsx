/**
 * Automatic updates in Parrot's window (REL-UPD-01), over the shared desktop updater (`@space/desktop-shell/updater`).
 * The main process keeps the setting (ON unless the user turned it off), checks at start, every 4 hours, when the
 * computer wakes and when the window comes back (REL-UPD-08), and downloads in the background; a downloaded version
 * installs the next time Parrot closes.
 *  - `ParrotUpdateSection`: Settings › About & updates, the shared `DesktopUpdateSection` (REL-UPD-05, the section
 *    Badger shows too) over `window.parrot.updater`, with the automatic-updates switch saved in main.
 *  - `ParrotUpdatePrompt`: on every screen, the shared `DesktopUpdatePrompt` (the modal Badger shows too, REL-UPD-08)
 *    offers the new version with Remind me later and Ignore: "Restart now" once it has downloaded, "Install now"
 *    through the package manager for a .deb/.rpm/.pacman copy (REL-UPD-07), the `flatpak update` command for Flatpak.
 *    It waits while music plays or an import/export runs. A mandatory update has its own blocking screen
 *    (`UpdateRequiredGate`), so the modal stays out of its way.
 */
import { useDesktopUpdater, type DesktopUpdaterControls } from "@space/desktop-shell/updater-react";
import { DesktopUpdatePrompt } from "@space/desktop-shell/updater-prompt";
import { DesktopUpdateSection } from "@space/desktop-shell/updater-section";
import type { ParrotLanguage } from "../../shared/ipc";

const logUpdaterError = (message: string, context: string) => console.error(`[updater] ${context}: ${message}`);

const useParrotUpdater = (): DesktopUpdaterControls => useDesktopUpdater(window.parrot?.updater, logUpdaterError);

export function ParrotUpdateSection({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  return (
    <DesktopUpdateSection
      controls={updater}
      language={language}
      appName="Parrot"
      autoUpdate={{ checked: updater.state.autoUpdate, onCheckedChange: (on) => void updater.setAutoUpdate(on) }}
    />
  );
}

export function ParrotUpdatePrompt({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  return <DesktopUpdatePrompt controls={updater} language={language} appName="Parrot" />;
}
