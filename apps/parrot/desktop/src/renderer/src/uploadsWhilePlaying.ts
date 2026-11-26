import { useEffect, useState } from "react";
import type { ParrotUploadsWhilePlaying } from "../../shared/ipc";

export const UPLOADS_WHILE_PLAYING_MODES: ParrotUploadsWhilePlaying["mode"][] = ["full", "throttle", "pause"];

/**
 * PAR-UP-15: this computer's "imports while a song plays" setting, from main. undefined = no bridge (browser build,
 * tests without it) → the row is hidden; null = still loading.
 */
export function useUploadsWhilePlaying(): {
  value: ParrotUploadsWhilePlaying | null | undefined;
  set: (mode: ParrotUploadsWhilePlaying["mode"]) => void;
} {
  const bridge = typeof window === "undefined" ? undefined : window.parrot;
  const available = typeof bridge?.getUploadsWhilePlaying === "function";
  const [value, setValue] = useState<ParrotUploadsWhilePlaying | null | undefined>(available ? null : undefined);
  useEffect(() => {
    if (!available) return;
    let live = true;
    void bridge.getUploadsWhilePlaying().then(
      (answer) => {
        if (live) setValue(answer);
      },
      (error: unknown) => console.warn(`[upload-gate] reading the setting failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    return () => {
      live = false;
    };
  }, [available, bridge]);
  const set = (mode: ParrotUploadsWhilePlaying["mode"]) => {
    if (!available) return;
    setValue((current) => (current ? { ...current, mode, picked: true } : current));
    void bridge.setUploadsWhilePlaying(mode).then(
      (answer) => setValue(answer),
      (error: unknown) => console.warn(`[upload-gate] saving ${mode} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  return { value, set };
}
