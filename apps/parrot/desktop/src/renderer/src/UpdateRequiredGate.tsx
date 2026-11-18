/**
 * REL-CD-29: this build is too old, so Parrot shows the shared blocking update screen (`DesktopUpdateRequiredScreen`,
 * the same one Badger shows) over every screen, sign-in included. Two signals say so, and they read the same minimum
 * on the API side:
 *  - a refusal: an API call made by main was refused with "please update" (426); main tells the window
 *    (`getAppUpdateRequired` / `onAppUpdateRequired`) and the gate checks once for the update the user now needs;
 *  - the updater's latched `state.mandatory`: the desktop `release-status` reported this build below
 *    `minClientVersion`, from a check main already ran.
 */
import { useEffect, useState } from "react";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";
import { useDesktopUpdater } from "@space/desktop-shell/updater-react";
import { DesktopUpdateRequiredScreen } from "@space/desktop-shell/updater-required";
import type { ParrotLanguage } from "../../shared/ipc";

const logUpdaterError = (message: string, context: string) => console.error(`[updater] ${context}: ${message}`);

export function UpdateRequiredGate({ language }: { language: ParrotLanguage }) {
  const controls = useDesktopUpdater(window.parrot?.updater, logUpdaterError);
  const { check } = controls;
  const [refusal, setRefusal] = useState<AppUpdateRequiredPayload | null>(null);

  useEffect(() => {
    let live = true;
    const off = window.parrot.onAppUpdateRequired((payload) => setRefusal(payload));
    void window.parrot.getAppUpdateRequired().then((payload) => {
      if (live && payload) setRefusal(payload);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  // One check per refusal: main latches the first one and never clears it.
  useEffect(() => {
    if (!refusal) return;
    console.warn(`[parrot] app update required: ${refusal.version} is below ${refusal.minVersion}`);
    void check();
  }, [refusal, check]);

  if (!refusal && !controls.state.mandatory) return null;
  return (
    <DesktopUpdateRequiredScreen
      controls={controls}
      language={language}
      appName="Parrot"
      autoUpdate={{ checked: controls.state.autoUpdate, onCheckedChange: (enabled) => void controls.setAutoUpdate(enabled) }}
    />
  );
}
