import { useCallback, useEffect, useRef, useState } from "react";
import { MediaVolume } from "./MediaVolume";

/**
 * The live media volume (null until the first read) and a setter. Follows the hardware buttons; while the user drags
 * (`setLevel` called with `dragging`), incoming changes are ignored so the thumb does not jump back to a rounded step.
 */
export const useMediaVolume = () => {
  const [level, setLevelState] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let alive = true;
    MediaVolume.get()
      .then((v) => alive && setLevelState(v))
      .catch((e: unknown) => console.warn("media-volume.read.failed", String(e)));
    const sub = MediaVolume.onChange((v) => {
      console.info("media-volume.changed", JSON.stringify({ level: v, dragging: dragging.current }));
      if (!dragging.current) setLevelState(v);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const setLevel = useCallback((next: number, phase: "drag" | "end" = "end") => {
    dragging.current = phase === "drag";
    setLevelState(next);
    MediaVolume.set(next)
      .then((applied) => {
        console.info("media-volume.set", JSON.stringify({ asked: next, applied, phase }));
        if (phase === "end") setLevelState(applied);
      })
      .catch((e: unknown) => console.warn("media-volume.set.failed", String(e)));
  }, []);

  return { level, setLevel };
};
