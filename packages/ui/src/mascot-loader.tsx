import { useEffect, useRef } from "react";
import {
  MASCOT_LOADER_BOX,
  MASCOT_LOADER_OUTLINE,
  MASCOT_LOADERS,
  mascotLoaderKeyframes,
  type MascotLoaderApp,
  type MascotLoaderPose,
} from "@space/shared/mascotLoader";
import { cn } from "./utils";

type MascotLoaderProps = {
  app: MascotLoaderApp;
  /** The app's mascot picture (`@space/ui/badger/mascot.webp`, `@space/parrot-core/mascot.webp`). */
  src: string;
  /** Side of the square, CSS px. */
  size?: number;
  className?: string;
};

const transformOf = (pose: MascotLoaderPose, k: number) =>
  `translate(${pose.x * k}px, ${pose.y * k}px) rotate(${pose.rotate}deg) scale(${pose.scaleX}, ${pose.scaleY})`;

/**
 * The animated mascot above the loading text of the web and desktop loading screens (UX-WAIT-02). It is decorative:
 * the loading text next to it stays the accessible status. The motion is `@space/shared/mascotLoader`'s, run by the
 * Web Animations API on the compositor; with reduced motion asked for, the mascot stands still.
 */
export const MascotLoader = ({ app, src, size = 120, className }: MascotLoaderProps) => {
  const spec = MASCOT_LOADERS[app];
  const k = size / MASCOT_LOADER_BOX;
  const layerRefs = useRef<(HTMLElement | SVGSVGElement | null)[]>([]);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const frames = mascotLoaderKeyframes(app);
    const animations = layerRefs.current.map((el, layer) =>
      el?.animate?.(
        frames[layer]!.map((pose) => ({ transform: transformOf(pose, k), opacity: pose.opacity })),
        { duration: spec.durationMs, iterations: Infinity, easing: "linear" },
      ),
    );
    return () => animations.forEach((animation) => animation?.cancel());
  }, [app, k, spec.durationMs]);

  const rest = spec.pose(0);
  return (
    <div
      aria-hidden="true"
      data-testid={`mascot-loader-${app}`}
      className={cn("pointer-events-none relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {spec.layers.map((layer, i) => {
        const pose = rest[i]!;
        const style = {
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: transformOf(pose, k),
          opacity: pose.opacity,
          willChange: "transform, opacity",
        } as const;
        const setRef = (el: HTMLElement | SVGSVGElement | null) => {
          layerRefs.current[i] = el;
        };
        if (layer.kind === "mascot") {
          const w = layer.width * k;
          const h = layer.height * k;
          return (
            <div key={layer.id} ref={setRef} style={style}>
              <img
                src={src}
                alt=""
                draggable={false}
                // maxWidth: Tailwind's preflight caps images at their parent's width, and this zero-width layer would squash it.
                style={{ position: "absolute", left: -w / 2, top: -h / 2, width: w, height: h, maxWidth: "none", objectFit: "contain" }}
              />
            </div>
          );
        }
        // Props are drawn around (0, 0) in box units; a 64-unit viewport covers each note.
        const s = 64 * k;
        return (
          <div key={layer.id} ref={setRef} style={style}>
            <svg
              width={s}
              height={s}
              viewBox="-32 -32 64 64"
              style={{ position: "absolute", left: -s / 2, top: -s / 2, overflow: "visible" }}
            >
              <g fill={layer.fill} stroke={MASCOT_LOADER_OUTLINE} strokeWidth={3} strokeLinejoin="round">
                {layer.shapes.map((shape, j) =>
                  shape.kind === "path" ? (
                    <path key={j} d={shape.d} />
                  ) : (
                    <ellipse
                      key={j}
                      cx={shape.cx}
                      cy={shape.cy}
                      rx={shape.rx}
                      ry={shape.ry}
                      transform={`rotate(${shape.rotate} ${shape.cx} ${shape.cy})`}
                    />
                  ),
                )}
              </g>
            </svg>
          </div>
        );
      })}
    </div>
  );
};
