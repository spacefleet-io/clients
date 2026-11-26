import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger, cn } from "@space/ui";

type DesktopNotificationTrayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  title: string;
  subtitle: string;
  emptyMessage: string;
  /** A z-index class for the tray and its backdrop, above a page's own fixed header (the website's top bar is z-100). */
  layerClassName?: string;
  children?: ReactNode;
};

export function DesktopNotificationTray({
  open,
  onOpenChange,
  trigger,
  title,
  subtitle,
  emptyMessage,
  layerClassName,
  children,
}: DesktopNotificationTrayProps) {
  const hasContent = Boolean(children);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="right"
        className={cn("flex w-[340px] flex-col bg-[#0d1117] text-white", layerClassName)}
        overlayClassName={layerClassName}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>
        <div className="-mr-3 mt-5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {hasContent ? (
            children
          ) : (
            <div className="rounded-lg border border-[#30363d] bg-[#0b1220] p-3 text-xs text-[#8b949e]">
              {emptyMessage}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
