/**
 * Automatic updates in Parrot's window (REL-UPD-01), over the shared desktop updater (`@space/desktop-shell/updater`).
 * The main process keeps the setting (ON unless the user turned it off), checks at start and every 6 hours, and
 * downloads in the background; a downloaded version installs the next time Parrot closes.
 *  - `ParrotUpdateSection`: Settings › About & updates, the shared `DesktopUpdateSection` (REL-UPD-05, the section
 *    Badger shows too) over `window.parrot.updater`, with the automatic-updates switch saved in main.
 *  - `ParrotUpdateReadyNotice`: on every screen, once a version has downloaded, the shared `DesktopUpdateReadyNotice`
 *    (the card Badger shows too) offers "Restart now". A mandatory update has its own blocking screen
 *    (`UpdateRequiredGate`), so the card stays out of its way.
 *  - `ParrotSystemUpdatePrompt`: a copy from SpaceFleet's .deb/.rpm/.pacman packages asks before updating through the
 *    package manager (REL-UPD-07, the shared `SystemUpdatePrompt`); a Flatpak copy shows `flatpak update`.
 */
import { useDesktopUpdater, type DesktopUpdaterControls } from "@space/desktop-shell/updater-react";
import { DesktopUpdateReadyNotice } from "@space/desktop-shell/updater-ready-notice";
import { DesktopUpdateSection } from "@space/desktop-shell/updater-section";
import { SystemUpdatePrompt } from "@space/desktop-shell/updater-system-prompt";
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

export function ParrotSystemUpdatePrompt({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  return <SystemUpdatePrompt controls={updater} language={language} appName="Parrot" />;
}

export function ParrotUpdateReadyNotice({ language }: { language: ParrotLanguage }) {
  const updater = useParrotUpdater();
  // Sits above the player bar.
  return <DesktopUpdateReadyNotice controls={updater} language={language} appName="Parrot" className="bottom-24 right-4" />;
}
