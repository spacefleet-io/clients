import { memo, useEffect, useRef } from "react";
import { nebulaCss, type SkyNebulaName } from "@space/shared/skyNebula";
import { createSkyMotionGate } from "@space/shared/starSky";
import { APP_BUSY_ATTRIBUTE } from "./app-busy-mark";
import { APP_PLAYBACK_ATTRIBUTE } from "./app-playback-mark";
import StarSky from "./star-sky";

/**
 * The fleet's star sky in the apps: Badger desktop, Parrot desktop and
 * Parrot's and Badger's web players. It draws the website hero's sky
 * (`StarSky`, UX-SKY-02: the same still stars and looping shooting stars)
 * and adds the apps' gate on top (UX-SKY-01). Under the stars it paints the
 * app's nebula, if any (`nebula`, UX-SKY-03: Parrot's green, Badger's yellow,
 * from `@space/shared/skyNebula`); the rest is transparent over the app's
 * `body`, and content stacks above it (`fixed`, `z-0`).
 *
 * Render cost: anything animating here makes the display compositor draw 60
 * frames a second, pure CPU under software compositing (issue #25). The stars
 * never animate; the shooting stars are removed ("still") from the first input
 * (pointer, wheel, scroll, key, touch) until 5 s of quiet, and ("off") while the
 * page or the window is hidden (`<html data-app-window-hidden>`), during
 * playback (`<html data-app-playback>`), while the app processes media
 * (`<html data-app-busy>`, #2461) or when the user prefers reduced motion.
 * `display: none` shooting stars schedule no frames, so interaction never
 * competes with the sky.
 */
const INPUT_EVENTS = ["pointermove", "pointerdown", "wheel", "keydown", "touchstart", "scroll"] as const;

type AppBackdropProps = {
  /** The app's nebula under the stars (UX-SKY-03): Parrot's green, Badger's yellow. */
  nebula?: SkyNebulaName;
};

function AppBackdrop({ nebula }: AppBackdropProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const backdrop = containerRef.current;
    if (!backdrop) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const gate = createSkyMotionGate({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      onChange: (motion) => backdrop.setAttribute("data-sky-motion", motion),
    });

    // Badger runs with backgroundThrottling: false, so hiding its window never
    // flips document.hidden; it marks <html data-app-window-hidden> instead
    // (issue #25 P1 residual).
    const root = document.documentElement;
    const syncBlocked = () =>
      gate.setBlocked(
        !!reducedMotion?.matches ||
          document.hidden ||
          root.hasAttribute("data-app-window-hidden") ||
          root.hasAttribute(APP_PLAYBACK_ATTRIBUTE) ||
          root.hasAttribute(APP_BUSY_ATTRIBUTE),
      );
    const rootMarks = new MutationObserver(syncBlocked);
    const onInput = gate.noteInput;

    syncBlocked();
    reducedMotion?.addEventListener?.("change", syncBlocked);
    document.addEventListener("visibilitychange", syncBlocked);
    rootMarks.observe(root, { attributes: true, attributeFilter: ["data-app-window-hidden", APP_PLAYBACK_ATTRIBUTE, APP_BUSY_ATTRIBUTE] });
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
    return () => {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
      reducedMotion?.removeEventListener?.("change", syncBlocked);
      document.removeEventListener("visibilitychange", syncBlocked);
      rootMarks.disconnect();
      gate.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-testid="app-backdrop"
      data-sky-motion="off"
      className="pointer-events-none fixed inset-0 z-0"
      style={{ contain: "strict", transform: "translateZ(0)", overflow: "hidden", backgroundImage: nebula ? nebulaCss(nebula) : undefined }}
    >
      <StarSky />
    </div>
  );
}

export default memo(AppBackdrop);
