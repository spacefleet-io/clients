/**
 * Parrot's music pieces for the browser-engine apps (desktop renderer and web player), drawn from the approved design
 * (PAR-LOOK-01): the album art, the equaliser on what is playing, and the waveform seek bar.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../utils";
import { parrotCoverArt, parrotWaveBars } from "@space/parrot-core/art";

const MOTION_CSS = `
@keyframes parrot-eq-bounce { 0%, 100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: no-preference) {
  .parrot-eq[data-animated="true"] i { animation: parrot-eq-bounce 900ms ease-in-out infinite; transform-origin: bottom; }
  .parrot-eq[data-animated="true"] i:nth-child(2) { animation-delay: -300ms; }
  .parrot-eq[data-animated="true"] i:nth-child(3) { animation-delay: -600ms; }
}`;

/** Three bars; they bounce while the music plays (`animated`), unless the system asks for reduced motion. */
export function ParrotEqualizer({ animated = false, className }: { animated?: boolean; className?: string }) {
  return (
    <span className={cn("parrot-eq inline-flex h-3 items-end gap-[2px]", className)} data-animated={animated} aria-hidden="true">
      <style>{MOTION_CSS}</style>
      {[6, 12, 9].map((height, i) => (
        <i key={i} className="block w-[3px] rounded-[1px] bg-current" style={{ height }} />
      ))}
    </span>
  );
}

/**
 * An artist's or album's name that opens its page (PAR-NAV-05): underlined on hover, like a link. The click stays on the
 * name, so a row or card around it does not also play or open. Plain text when there is no page to open (`onOpen`
 * absent: no artist, or an album the library does not hold).
 */
export function ParrotNameLink({ children, onOpen, className, testId, title }: { children: ReactNode; onOpen?: () => void; className?: string; testId?: string; title?: string }) {
  if (!onOpen) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn("max-w-full cursor-pointer truncate text-left align-bottom hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none", className)}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(event: MouseEvent) => event.stopPropagation()}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

const motifLayer = (motif: string, light: string): CSSProperties[] => {
  switch (motif) {
    case "sun":
      return [{ left: "52%", top: "14%", width: "38%", height: "38%", borderRadius: "999px", background: light, opacity: 0.85 }];
    case "stripes":
      return [{ inset: 0, background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.09) 0 7%, transparent 7% 16%)" }];
    case "rings":
      return [
        { left: "-12%", bottom: "-18%", width: "70%", height: "70%", borderRadius: "999px", border: `2px solid ${light}`, opacity: 0.35 },
        { left: "0%", bottom: "-6%", width: "46%", height: "46%", borderRadius: "999px", border: `2px solid ${light}`, opacity: 0.35 },
      ];
    default:
      return [
        { left: "34%", top: "40%", width: "32%", height: "32%", borderRadius: "999px", background: light, opacity: 0.8 },
        { left: 0, right: 0, bottom: 0, height: "40%", background: "rgba(0,0,0,0.38)" },
      ];
  }
};

type ParrotCoverProps = {
  /** The album id: the same album always gets the same picture. */
  seed: string;
  /** Written on the drawn picture's bottom-left, as on a record sleeve; a real cover (`src`) carries its own text. */
  label?: string;
  /** Rings the cover in green and shows the equaliser badge. */
  playing?: boolean;
  /** The badge's bars move only while the music really plays. */
  animated?: boolean;
  className?: string;
  rounded?: string;
  /** The album's own cover (PAR-META-04): fills the tile instead of the drawn picture and its label; the drawn one stays when absent or broken. */
  src?: string | null;
  /**
   * PAR-UP-07, PAR-META-20: the picture is still being fetched (an import or a lookup is asking for it). Until a picture
   * arrives a plain shimmering tile shows, never the drawn picture, so "still coming" never looks like "no picture".
   */
  fetching?: boolean;
};

/**
 * The album's cover when it has one (`src`), else its drawn picture from `parrotCoverArt` (PAR-LOOK-01). While a cover
 * is on its way (its picture loading, or `fetching`) a plain shimmering tile shows, never the drawn picture (PAR-META-20):
 * the drawn picture means "no cover". The cover fades in over the shimmer when its picture has loaded (a cross-fade,
 * still under reduced motion). A cover that fails to load leaves the drawn picture.
 * `data-cover`: "drawn" (no cover), "loading" (cover picture on its way: shimmer), "image" (cover shown),
 * "fetching" (no cover yet and still being fetched: shimmer).
 */
export function ParrotCover({ seed, label, playing = false, animated = false, className, rounded = "rounded-[calc(var(--radius)-2px)]", src, fetching = false }: ParrotCoverProps) {
  const art = useMemo(() => parrotCoverArt(seed), [seed]);
  // The address that failed to load: a new address is tried again, a broken one falls back to the drawn picture.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // The address whose picture has loaded: only then does the cover show over the drawn one.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const image = src && src !== failedSrc ? src : null;
  const shown = image !== null && image === loadedSrc;
  const waiting = (fetching && !image) || (image !== null && !shown);
  const fade = "motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-out";
  return (
    <div
      className={cn(
        "relative aspect-square overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
        rounded,
        playing && "outline outline-2 outline-offset-[3px] outline-primary",
        className
      )}
      style={waiting ? undefined : { background: `linear-gradient(140deg, ${art.from}, ${art.to})` }}
      data-testid="parrot-cover"
      data-motif={art.motif}
      data-cover={shown ? "image" : image ? "loading" : waiting ? "fetching" : "drawn"}
    >
      {waiting && <span className="pointer-events-none absolute inset-0 bg-muted motion-safe:animate-pulse" aria-hidden data-testid="parrot-cover-fetching" />}
      <span className={cn("pointer-events-none absolute inset-0", fade, shown || waiting ? "opacity-0" : "opacity-100")} aria-hidden={shown || waiting || undefined} data-testid="parrot-cover-drawn">
        {motifLayer(art.motif, art.light).map((style, i) => (
          <span key={i} className="pointer-events-none absolute" style={style} />
        ))}
        {label && (
          <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/45 to-transparent px-[9%] pb-[8%] pt-[18%] text-[11px] font-bold text-white">
            {label}
          </span>
        )}
      </span>
      {image && (
        <img
          key={image}
          src={image}
          alt=""
          draggable={false}
          className={cn("pointer-events-none absolute inset-0 h-full w-full object-cover", fade, shown ? "opacity-100" : "opacity-0")}
          // A picture already in the browser's cache can be complete before React sees its load event.
          ref={(element) => {
            if (element?.complete && element.naturalWidth > 0) setLoadedSrc(image);
          }}
          onLoad={() => setLoadedSrc(image)}
          onError={() => setFailedSrc(image)}
          data-testid="parrot-cover-image"
        />
      )}
      {playing && (
        <span className="absolute bottom-[6%] right-[6%] grid h-[18%] max-h-8 min-h-5 w-[18%] min-w-5 max-w-8 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_14px_rgba(0,0,0,0.4)]">
          <ParrotEqualizer animated={animated} />
        </span>
      )}
    </div>
  );
}

type ParrotWaveSeekProps = {
  /** The song id: the same song always draws the same wave. */
  seed: string;
  /** Played share, 0 to 1. */
  progress: number;
  onSeek?: (fraction: number) => void;
  label: string;
  /** Spoken value, e.g. "1:12 of 3:48". */
  valueText?: string;
  bars?: number;
  height?: number;
  className?: string;
  testId?: string;
};

/** The waveform seek bar (PAR-LOOK-01): green up to the playing point; click or arrow keys to seek. */
export function ParrotWaveSeek({ seed, progress, onSeek, label, valueText, bars = 96, height = 18, className, testId = "parrot-wave-seek" }: ParrotWaveSeekProps) {
  const heights = useMemo(() => parrotWaveBars(seed, bars), [seed, bars]);
  const played = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const seekAt = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 0.05 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -0.05 : 0;
    if (event.key === "Home") onSeek(0);
    else if (event.key === "End") onSeek(1);
    else if (step) onSeek(Math.max(0, Math.min(1, played + step)));
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="slider"
      tabIndex={onSeek ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      aria-valuetext={valueText}
      className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-[2px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      style={{ height }}
      onPointerDown={seekAt}
      onKeyDown={onKeyDown}
      data-testid={testId}
    >
      {heights.map((h, i) => (
        <i
          key={i}
          className={cn("block flex-1 rounded-[2px]", (i + 0.5) / heights.length <= played ? "bg-primary" : "bg-foreground/20")}
          style={{ height: Math.max(3, h * height) }}
        />
      ))}
    </div>
  );
}
