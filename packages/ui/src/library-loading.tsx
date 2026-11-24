import type { MascotLoaderApp } from "@space/shared/mascotLoader";
import { MascotLoader } from "./mascot-loader";
import { cn } from "./utils";

type MascotLoadingProps = {
  app: MascotLoaderApp;
  /** The app's mascot picture (`@space/ui/badger/mascot.webp`, `@space/parrot-core/mascot.webp`). */
  src: string;
  /** The loading text under the mascot, in the app's language. Without it the wait is the mascot alone. */
  label?: string;
  className?: string;
};

/** The mascot above its text, the one look of every web and desktop wait (UX-WAIT-02). */
const MascotAboveLabel = ({ app, src, label }: { app: MascotLoaderApp; src: string; label?: string }) => (
  <>
    <MascotLoader app={app} src={src} size={120} />
    {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
  </>
);

/**
 * The web and desktop apps' wait (UX-WAIT-02): the app's animated mascot, in the spinner's place, above the loading
 * text when there is one. The text is the accessible status (`role="status"`); the mascot is decorative, so a wait
 * without text (the app's start) carries no role.
 */
export const MascotLoading = ({ app, src, label, className }: MascotLoadingProps) => (
  <div className={cn("flex flex-col items-center gap-4", className)} role={label ? "status" : undefined}>
    <MascotAboveLabel app={app} src={src} label={label} />
  </div>
);

/**
 * UX-WAIT-04: what Home and the library page show while the library opens and while its content is not known yet, in
 * the empty library's place: the mascot above "Loading library…", always announced (`role="status"`). `className`
 * places it in each app's page (pinned below the top bar, or filling the scrolling page), so the mascot sits in the
 * middle of the area the library will take.
 */
export const LibraryLoading = ({ app, src, label, className }: MascotLoadingProps & { label: string }) => (
  <div className={className} role="status" data-testid="library-loading">
    <div className="flex flex-col items-center gap-4">
      <MascotAboveLabel app={app} src={src} label={label} />
    </div>
  </div>
);
