/**
 * Which steps of the first-open tour this computer has seen (UX-TOUR-02, PAR-TOUR-02), one flag per step so each step
 * shows once, at its own moment. Kept per computer in the renderer's local storage, which is per app; Badger's sign-out
 * keeps these keys when it clears the rest (`DESKTOP_TOUR_STORAGE_KEYS`), so a sign-out never brings the tour back.
 */
export const DESKTOP_TOUR_STEPS = ["intro", "review", "jobs"] as const;
export type DesktopTourStepId = (typeof DESKTOP_TOUR_STEPS)[number];

const stepKey = (step: DesktopTourStepId): string => `sf_desktop_tour_${step}_seen_v2`;
export const DESKTOP_TOUR_STORAGE_KEYS: readonly string[] = DESKTOP_TOUR_STEPS.map(stepKey);

const read = (key: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
};

const write = (key: string, seen: boolean): void => {
  try {
    if (seen) globalThis.localStorage?.setItem(key, "1");
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // A storage error only means a step may show once more.
  }
};

export const isDesktopTourStepSeen = (step: DesktopTourStepId): boolean => read(stepKey(step));
export const markDesktopTourStepSeen = (step: DesktopTourStepId): void => write(stepKey(step), true);
/** "Skip tour" on any step: none of the steps shows again on its own. */
export const skipDesktopTour = (): void => DESKTOP_TOUR_STEPS.forEach((step) => write(stepKey(step), true));

/** Event the Settings button sends; the tour host on Home opens step 1 when it hears it or mounts after it. */
export const DESKTOP_TOUR_START_EVENT = "sf:desktop-tour-start";
let startRequested = false;

/**
 * "Show the tour again" (UX-TOUR-04, PAR-TOUR-04): forgets every step, so step 1 opens now (the host hears the event)
 * or when Home mounts next (the host takes the pending request), and steps 2 and 3 show again on the next import.
 */
export const startDesktopTour = (): void => {
  DESKTOP_TOUR_STEPS.forEach((step) => write(stepKey(step), false));
  startRequested = true;
  globalThis.dispatchEvent?.(new Event(DESKTOP_TOUR_START_EVENT));
};

/** Whether `startDesktopTour` is pending, without clearing it. */
export const isDesktopTourRequested = (): boolean => startRequested;

/** True once after `startDesktopTour`: the host clears the request as it opens step 1. */
export const takeDesktopTourRequest = (): boolean => {
  const requested = startRequested;
  startRequested = false;
  return requested;
};
