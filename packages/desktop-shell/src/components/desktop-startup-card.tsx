import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@space/ui";
import { FloatingMascot, MASCOT_GLOW } from "@space/ui/floating-mascot";

/** Where a setup screen sits in its flow (UX-SETUP-08): "Step N of M" above the title plus a segmented bar. */
export type DesktopStartupProgress = {
  current: number;
  total: number;
  /** The translated "Step N of M" text. */
  label: ReactNode;
  testId?: string;
};

type DesktopStartupCardProps = {
  eyebrow?: ReactNode;
  /** Replaces the eyebrow with the step count and bar of a numbered setup step. */
  progress?: DesktopStartupProgress;
  title?: ReactNode;
  /** The title's heading level (`h3` by default); a screen whose only heading is the card's title passes `h1`. */
  titleAs?: "h1" | "h3";
  description?: ReactNode;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
  /**
   * `card` (setup and onboarding steps, UX-SETUP-08): the phone's look, the mascot about half over the card's top
   * border with a soft disc of the app's colour behind it, and the card's top padded so nothing sits under it.
   * `above`: the sign-in screens' small mascot floating apart above the card, as on the phone's sign-in. It takes its
   * own room above the card, so a card taller than the window never pushes it under the window's top bar.
   */
  mascotPlacement?: "card" | "above";
  headerActions?: ReactNode;
  children: ReactNode;
  /** A quiet extra way in under the main form, like "Sign in with another device". */
  secondary?: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
  contentClassName?: string;
};

const StepBar = ({ current, total, label, testId }: DesktopStartupProgress) => (
  <div className="space-y-3 pb-3 text-left" data-testid="setup-step-bar">
    <p className="text-[11px] font-black uppercase tracking-[0.2em] text-primary" data-testid={testId}>
      {label}
    </p>
    <div
      className="flex gap-1.5"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={typeof label === "string" ? label : undefined}
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`h-1 flex-1 rounded-full ${i < current ? "bg-primary" : "bg-white/10"}`} />
      ))}
    </div>
  </div>
);

export const DesktopStartupCard = ({
  eyebrow,
  progress,
  title,
  titleAs,
  description,
  mascotSrc,
  mascotAlt = "",
  mascotGlowClassName = MASCOT_GLOW.badger,
  mascotPlacement = "card",
  headerActions,
  children,
  secondary,
  footer,
  maxWidthClassName = "max-w-md",
  contentClassName,
}: DesktopStartupCardProps) => {
  const wrapperClassName = ["relative", "w-full", maxWidthClassName].filter(Boolean).join(" ");
  const contentClassNameValue = ["pb-8", "pt-4", contentClassName].filter(Boolean).join(" ");
  const onCard = Boolean(mascotSrc) && mascotPlacement === "card";
  return (
    <div className={wrapperClassName}>
      {mascotSrc && onCard ? (
        // The phone's look (`MobileSetupMascot`): the mascot is about 15% of the card's width (64 to 96 px, Chris
        // 2026-11-19: two thirds of the first fifth) and its lower 45% overlaps the card. In a short window it is at most
        // 12% of the window's height, so the step still fits the smallest window. Its glow is the phone's disc of the
        // app's colour at 16% plus the drop shadow.
        <div
          className="pointer-events-none absolute left-1/2 top-0 z-10 aspect-square w-[clamp(4rem,min(15%,12vh),6rem)] -translate-x-1/2 -translate-y-[55%]"
          data-testid="startup-card-mascot"
        >
          <div className="absolute inset-[8%] rounded-full bg-primary opacity-[0.16]" />
          <FloatingMascot src={mascotSrc} alt={mascotAlt} glowClassName={mascotGlowClassName} className="relative h-full w-full" />
        </div>
      ) : mascotSrc ? (
        <FloatingMascot
          src={mascotSrc}
          alt={mascotAlt}
          glowClassName={mascotGlowClassName}
          className="mx-auto mb-4"
          testId="startup-card-mascot-above"
        />
      ) : null}
      <Card className="w-full border-border/70 bg-card/80 backdrop-blur-md" data-testid="startup-card">
        {/* Under an on-card mascot the header starts below its overlap (45% of its width) plus 12 px; a padding
            percentage is of the card's width, so it follows the mascot's size: 6.75% is 45% of its 15%, 5.4vh 45% of
            its 12vh cap, and 2.55rem and 3.45rem 45% of its 4rem and 6rem bounds plus 0.75rem. */}
        <CardHeader className={`space-y-2 text-center ${onCard ? "pt-[clamp(2.55rem,calc(min(6.75%,5.4vh)_+_0.75rem),3.45rem)]" : "pt-8"}`}>
          {progress && progress.total > 0 ? (
            <StepBar {...progress} />
          ) : eyebrow ? (
            <CardDescription className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 sm:text-xs">
              {eyebrow}
            </CardDescription>
          ) : null}
          {title || headerActions ? (
            <div className="flex items-start justify-between gap-3 text-left">
              <div className="min-w-0 flex-1">
                {title ? <CardTitle as={titleAs}>{title}</CardTitle> : null}
                {description ? <CardDescription className="mt-2">{description}</CardDescription> : null}
              </div>
              {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
            </div>
          ) : null}
          {/* The header row above already shows the description when it is there (a title or header actions). */}
          {!title && !headerActions && description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className={contentClassNameValue}>
          {children}
          {secondary ? <div className="mt-5 text-center text-sm" data-testid="startup-secondary">{secondary}</div> : null}
        </CardContent>
        {footer}
      </Card>
    </div>
  );
};
