/**
 * Who wants the Apple TV remote's Menu key (UX-TV-01: Back).
 *
 * On tvOS a Menu press only reaches JavaScript (`BackHandler` / react-navigation's back handling) after
 * `TVEventControl.enableTVMenuKey()`. While it is off, the system keeps Menu: from the app's first screen it returns to the
 * Apple TV home screen, which is what Apple's HIG asks of a top-level screen. While it is on and nothing in JS consumes
 * the press, nothing happens at all (`BackHandler.exitApp` is a no-op on tvOS), so the key must be on only while some
 * screen really has somewhere to go back to: a pushed screen, a section other than Home, an open dialog or form.
 *
 * Each such screen holds the key under its own reason; the key is enabled while at least one hold is active and disabled
 * again when the last one is released. No React and no native module here, so the rules are unit-testable.
 */

/** The native switch (`TVEventControl.enableTVMenuKey` / `disableTVMenuKey`). */
export type MenuKeyControl = {
  enable: () => void;
  disable: () => void;
};

export type MenuKeyHolds = {
  /** Hold (`active`) or release (`!active`) the key for `reason`; idempotent per reason. */
  set: (reason: string, active: boolean) => void;
  /** Reasons currently holding the key (sorted, for logs and tests). */
  reasons: () => string[];
  /** Whether the native key is on. */
  enabled: () => boolean;
};

export const createMenuKeyHolds = (control: MenuKeyControl, log: (event: string, payload: Record<string, unknown>) => void = () => {}): MenuKeyHolds => {
  const holds = new Set<string>();
  let enabled = false;

  const sync = (reason: string, active: boolean) => {
    const want = holds.size > 0;
    log("tv.menuKey.hold", { reason, active, holds: [...holds].sort(), enabled: want });
    if (want === enabled) return;
    enabled = want;
    if (want) control.enable();
    else control.disable();
    log("tv.menuKey.native", { enabled });
  };

  return {
    set: (reason, active) => {
      if (active === holds.has(reason)) return;
      if (active) holds.add(reason);
      else holds.delete(reason);
      sync(reason, active);
    },
    reasons: () => [...holds].sort(),
    enabled: () => enabled,
  };
};

/** The root stack has a screen below the focused one, so Menu must pop it (details, player, pairing approval). */
export const stackHasScreenToPop = (routeCount: number): boolean => routeCount > 1;
