import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@space/ui";

/**
 * UX-LIST-01: the window behind a settings row whose list is long or depends on data (devices, languages, peers).
 * The settings page keeps one row with a short summary; this dialog holds the full list and scrolls on its own, so
 * the page itself never grows with the data. `toolbar` stays fixed above the scrolling list (e.g. a search box).
 */
export default function SettingListDialog({
  open,
  onOpenChange,
  title,
  description,
  toolbar,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  toolbar?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {toolbar}
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto pr-1" data-testid="setting-list-scroll">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
