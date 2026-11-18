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
  description?: ReactNode;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
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
  description,
  mascotSrc,
  mascotAlt = "",
  mascotGlowClassName = MASCOT_GLOW.badger,
  headerActions,
  children,
  secondary,
  footer,
  maxWidthClassName = "max-w-md",
  contentClassName,
}: DesktopStartupCardProps) => {
  const wrapperClassName = ["relative", "w-full", maxWidthClassName].filter(Boolean).join(" ");
  const contentClassNameValue = ["pb-8", "pt-4", contentClassName].filter(Boolean).join(" ");
  return (
    <div className={wrapperClassName}>
      {mascotSrc ? (
        <FloatingMascot
          src={mascotSrc}
          alt={mascotAlt}
          glowClassName={mascotGlowClassName}
          className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[120%]"
        />
      ) : null}
      <Card className="w-full border-border/70 bg-card/80 backdrop-blur-md">
        <CardHeader className="space-y-2 pt-8 text-center">
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
                {title ? <CardTitle>{title}</CardTitle> : null}
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
