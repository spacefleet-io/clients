import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@space/ui";

type DesktopNotificationTrayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  title: string;
  subtitle: string;
  emptyMessage: string;
  children?: ReactNode;
};

export function DesktopNotificationTray({
  open,
  onOpenChange,
  trigger,
  title,
  subtitle,
  emptyMessage,
  children,
}: DesktopNotificationTrayProps) {
  const hasContent = Boolean(children);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-[340px] flex-col bg-[#0d1117] text-white"
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
