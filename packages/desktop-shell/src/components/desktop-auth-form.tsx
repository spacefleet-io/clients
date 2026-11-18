import type { ReactNode } from "react";

export const desktopAuthInputClassName =
  "h-14 rounded-2xl border-border/70 bg-card pl-12 pr-4 text-sm font-bold placeholder:font-bold placeholder:uppercase placeholder:tracking-widest";
export const desktopAuthPromptActionClassName =
  "text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80 transition-colors hover:text-foreground/80";
export const desktopAuthSignupButtonClassName =
  "bg-[#dbe7f5] text-[#111827] hover:bg-[#c9d9ed] shadow-2xl shadow-[#dbe7f5]/20";
export const desktopAuthSignupAccentTextClassName = "text-[#dbe7f5]";

type DesktopAuthPrimaryButtonProps = {
  children: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  className: string;
};

export const DesktopAuthPrimaryButton = ({
  children,
  disabled,
  type = "submit",
  className,
}: DesktopAuthPrimaryButtonProps) => (
  <button
    type={type}
    disabled={disabled}
    className={`h-14 rounded-2xl font-black uppercase tracking-widest inline-flex items-center justify-center gap-2 ${className}`}
  >
    {children}
  </button>
);

type DesktopAuthPromptProps = {
  children: ReactNode;
};

export const DesktopAuthPrompt = ({ children }: DesktopAuthPromptProps) => (
  <div className="pt-1 text-center text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/80">
    {children}
  </div>
);
