import { memo } from "react";
import { Film, UserRound } from "lucide-react";
import type { ArtworkSource } from "@space/shared/artworkImage";
import { useArtworkState } from "@space/shared/useArtworkState";
import { cn } from "./utils";

/**
 * The spinner fades in after `ARTWORK_SPINNER_DELAY_MS` (150 ms) so a picture already on the device never flashes it;
 * it turns on the compositor (a CSS transform, no script per frame) and stands still as a plain ring under reduced
 * motion. React 19 hoists and dedupes this sheet by `href`, so a grid of hundreds of tiles adds it once.
 */
const ARTWORK_CSS = `
@keyframes sf-artwork-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes sf-artwork-spin { to { transform: rotate(360deg); } }
.sf-artwork-spinner { animation: sf-artwork-in 200ms ease-out 150ms both; }
.sf-artwork-spinner > i { display: block; width: 20px; height: 20px; border-radius: 9999px; border: 2px solid currentColor; border-top-color: transparent; animation: sf-artwork-spin 900ms linear infinite; }
@media (prefers-reduced-motion: reduce) { .sf-artwork-spinner > i { animation: none; } }
`;

export type ArtworkImageProps = {
  /** Where the picture stands, from the app's artwork hook. Key the tile by the artwork path. */
  source: ArtworkSource;
  alt: string;
  /** Classes of the tile box (it fills its parent by default); the picture always covers it. */
  className?: string;
  /** Shown with the icon when there is no picture: the title, so the tile still says what it is. */
  label?: string;
  /** The fallback's icon: a film for posters and stills, a person for cast faces. */
  icon?: "film" | "person";
  /** A backdrop or glow behind a page: only fades in, never shows a spinner or a fallback. */
  decorative?: boolean;
  testId?: string;
};

/**
 * One poster, still or face of the web player and the desktop app (UX-WAIT-03): a small spinner on the placeholder
 * while the picture comes, the picture faded in once drawn, and an icon with the title when there is none, it would
 * not load, or it took too long; never a plain dark box. `data-artwork` names the look (`loading`, `loaded`, `failed`).
 */
function ArtworkImageInner({ source, alt, className, label, icon = "film", decorative = false, testId = "artwork-image" }: ArtworkImageProps) {
  const { state, onLoad, onError } = useArtworkState(source);
  const { phase, url } = state;
  const Icon = icon === "person" ? UserRound : Film;
  return (
    <span
      className={cn("relative block h-full w-full overflow-hidden", !decorative && "bg-muted", className)}
      data-testid={testId}
      data-artwork={phase}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => onLoad(url)}
          onError={() => onError(url)}
          className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-200", phase === "loaded" ? "opacity-100" : "opacity-0")}
        />
      ) : null}
      {decorative ? null : (
        <>
          <style href="sf-artwork-image" precedence="default">
            {ARTWORK_CSS}
          </style>
          {phase === "loading" ? (
            <span className="sf-artwork-spinner absolute inset-0 flex items-center justify-center text-muted-foreground" aria-hidden data-testid="artwork-spinner">
              <i />
            </span>
          ) : null}
          {phase === "failed" ? (
            <span
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden p-2 text-center text-muted-foreground"
              aria-hidden
              data-testid="artwork-fallback"
            >
              <Icon className="h-6 w-6 flex-none opacity-70" />
              {label ? <span className="line-clamp-3 text-xs font-medium leading-snug">{label}</span> : null}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

export const ArtworkImage = memo(ArtworkImageInner);
