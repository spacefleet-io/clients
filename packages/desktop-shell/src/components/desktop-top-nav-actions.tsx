import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Button } from "@space/ui";
import { desktopTopNavTextActionBaseClassName } from "./desktop-top-nav-styles";

/** Other button props (aria-*, data-state) come from a wrapping Radix trigger (`asChild`) and reach the button. */
type DesktopTopNavIconActionProps = Omit<ComponentPropsWithoutRef<"button">, "title" | "children"> & {
  title: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  testId?: string;
};

type DesktopTopNavTextActionProps = {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
};

export function DesktopTopNavIconAction({
  title,
  onClick,
  children,
  className = "text-muted-foreground hover:bg-secondary/45 hover:text-white",
  disabled,
  type = "button",
  testId,
  ...rest
}: DesktopTopNavIconActionProps) {
  return (
    <Button
      {...rest}
      variant="ghost"
      size="icon"
      type={type}
      title={title}
      aria-label={rest["aria-label"] ?? title}
      onClick={onClick}
      disabled={disabled}
      className={`relative ${className}`}
      data-testid={testId}
    >
      {children}
    </Button>
  );
}

export function DesktopTopNavTextAction({
  children,
  onClick,
  className = "text-muted-foreground hover:bg-secondary/45 hover:text-white",
  disabled,
  type = "button",
}: DesktopTopNavTextActionProps) {
  return (
    <Button
      variant="ghost"
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${desktopTopNavTextActionBaseClassName} ${className}`}
    >
      {children}
    </Button>
  );
}
