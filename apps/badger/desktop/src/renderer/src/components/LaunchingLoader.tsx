import type { ReactNode } from "react";
import { X } from "lucide-react";
import { DialogClose, useCloseLabel } from "@space/ui";
import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/ui/badger/mascot.webp";

/**
 * The inside of the small waits shown over the app ("Launching player…", deleting, opening a title): the hovering
 * badger of the launch screens above the title and its detail line, straight on the dimmed backdrop with no card
 * (UX-WAIT-02, Chris 2026-11-18). With no card to sit in the corner of, the dialog's close button sits just right of
 * the title instead (its own corner one is hidden with `hideCloseButton`), while the title stays centred under the
 * badger. The text stays the accessible status; the mascot is decorative. Always rendered inside a Dialog.
 */
export const LaunchingLoader = ({ title, children }: { title: string; children?: ReactNode }) => {
  const closeLabel = useCloseLabel();
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center text-sm text-white" data-testid="launching-loader">
      <MascotLoader app="badger" src={mascotUrl} size={120} />
      <div className="relative">
        <div className="text-base font-semibold drop-shadow">{title}</div>
        <DialogClose
          className="absolute left-full top-1/2 ml-2 -translate-y-1/2 rounded-md p-1 text-white/60 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="launching-loader-close"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{closeLabel}</span>
        </DialogClose>
      </div>
      {children}
    </div>
  );
};
