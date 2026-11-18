import type { ReactNode } from "react";

export type NoticeSurfaceTone = "neutral" | "info" | "error";

export const noticeSurfaceToneClass = (tone: NoticeSurfaceTone): string => {
  if (tone === "error") {
    return "border-destructive/40 bg-destructive/10";
  }
  if (tone === "info") {
    return "border-primary/30 bg-primary/10";
  }
  return "border-border bg-muted/40 text-muted-foreground";
};

type NoticeSurfaceProps = {
  tone?: NoticeSurfaceTone;
  className?: string;
  children: ReactNode;
};

export const NoticeSurface = ({ tone = "neutral", className, children }: NoticeSurfaceProps) => {
  const toneClass = noticeSurfaceToneClass(tone);
  return <div className={["rounded-md border px-3 py-2 text-sm", toneClass, className ?? ""].join(" ")}>{children}</div>;
};
