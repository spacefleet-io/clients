import type { ReactNode } from "react";

type DesktopWelcomeHeroProps = {
  title: ReactNode;
  subtitle: ReactNode;
  action: ReactNode;
  backgroundImageSrc?: string;
  backgroundImageAlt?: string;
  className?: string;
  surfaceClassName?: string;
  backgroundImageClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  actionClassName?: string;
  overlays?: ReactNode;
};

const joinClassNames = (...values: Array<string | undefined | null | false>) =>
  values.filter(Boolean).join(" ");

export const DesktopWelcomeHero = ({
  title,
  subtitle,
  action,
  backgroundImageSrc,
  backgroundImageAlt = "",
  className,
  surfaceClassName,
  backgroundImageClassName,
  contentClassName,
  titleClassName,
  subtitleClassName,
  actionClassName,
  overlays,
}: DesktopWelcomeHeroProps) => {
  return (
    <div className={className}>
      <div
        className={joinClassNames(
          "relative overflow-hidden rounded-[32px] border border-[#30363d] bg-[#0f141b] text-white shadow-2xl",
          surfaceClassName
        )}
      >
        {backgroundImageSrc ? (
          <img
            src={backgroundImageSrc}
            alt={backgroundImageAlt}
            className={joinClassNames("absolute inset-0 h-full w-full object-cover", backgroundImageClassName)}
          />
        ) : null}
        {overlays}
        <div
          className={joinClassNames(
            "relative z-10 flex min-h-[340px] flex-col items-center justify-center px-8 py-20 text-center md:min-h-[380px] md:px-12 md:py-24",
            contentClassName
          )}
        >
          <div className="max-w-2xl space-y-4">
            <h2
              className={joinClassNames(
                "text-4xl font-black uppercase tracking-tight text-white md:text-6xl",
                titleClassName
              )}
            >
              {title}
            </h2>
            <p className={joinClassNames("text-sm leading-7 text-white/60 md:text-base", subtitleClassName)}>
              {subtitle}
            </p>
            <div className={joinClassNames("flex justify-center pt-2", actionClassName)}>{action}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
