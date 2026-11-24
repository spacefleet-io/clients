import { LibraryLoading as SharedLibraryLoading, MascotLoading } from "@space/ui/library-loading";
import mascotUrl from "@space/ui/badger/mascot.webp";

/** The full-screen wait while Badger opens (account, profiles, language): the hovering badger above its text (UX-WAIT-02). */
export const LoadingScreen = ({ label }: { label: string }) => (
  <div className="min-h-screen bg-background">
    <div className="container grid min-h-screen place-items-center">
      <MascotLoading app="badger" src={mascotUrl} label={label} />
    </div>
  </div>
);

/**
 * UX-WAIT-04: Home's and the library page's wait, pinned to the window below the 4rem top bar, so the badger sits in
 * the middle of that area whatever the page puts above it (the library page's tabs and filters); it lets clicks
 * through to them.
 */
export const LibraryLoading = ({ label }: { label: string }) => (
  <SharedLibraryLoading
    app="badger"
    src={mascotUrl}
    label={label}
    className="pointer-events-none fixed inset-x-0 bottom-0 top-16 grid place-items-center"
  />
);
