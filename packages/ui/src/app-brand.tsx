import { memo } from "react";

type AppBrandProps = {
  logoSrc: string;
  logoAlt: string;
  title: string;
};

/** The wiggle the logo plays once each time the pointer comes onto the brand: 560 ms, ease-out (UX-BRAND-01). */
export const APP_BRAND_WIGGLE = { name: "app-brand-wiggle", durationMs: 560, easing: "ease-out" } as const;

/**
 * The top-left app brand of every fleet app in a browser engine (Badger and Parrot desktops, the Parrot web
 * player): the logo and the app's name. The logo giggles on hover, the same motion in every app (UX-BRAND-01), and
 * stays still when the system asks for reduced motion. Only the logo and the name are the hover target: the outer
 * block keeps the header's layout width, but the `app-brand-link` hit box is shrink-wrapped to its content so the
 * empty header space next to the name never starts the wiggle (UX-BRAND-01, Chris 2026-11-09 hand-try).
 */
function AppBrand({ logoSrc, logoAlt, title }: AppBrandProps) {
  return (
    <div className="flex min-w-0 select-none items-center sm:min-w-[116px]" data-testid="app-brand">
      <style>{`
        @keyframes ${APP_BRAND_WIGGLE.name} {
          0% { transform: rotate(0deg) scale(1); }
          20% { transform: rotate(-8deg) scale(1.04); }
          40% { transform: rotate(7deg) scale(1.04); }
          60% { transform: rotate(-5deg) scale(1.03); }
          80% { transform: rotate(4deg) scale(1.02); }
          100% { transform: rotate(0deg) scale(1); }
        }
        @media (prefers-reduced-motion: no-preference) {
          .app-brand-link .app-brand-mark {
            transform-origin: 50% 70%;
          }

          .app-brand-link:hover .app-brand-mark {
            animation: ${APP_BRAND_WIGGLE.name} ${APP_BRAND_WIGGLE.durationMs}ms ${APP_BRAND_WIGGLE.easing} 1;
          }
        }
      `}</style>
      <span
        className="app-brand-link inline-flex w-fit min-w-0 flex-none cursor-default items-center gap-3 font-semibold tracking-tight text-white"
        data-testid="app-brand-hit"
      >
        <img className="app-brand-mark h-8 w-8 object-contain" src={logoSrc} alt={logoAlt} />
        <span className="app-brand-wordmark hidden sm:inline">{title}</span>
      </span>
    </div>
  );
}

export default memo(AppBrand);
