import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/ui/badger/mascot.webp";

/** The hovering badger above the loading text (UX-WAIT-02). The text stays the accessible status; the mascot is decorative. */
const MascotWithLabel = ({ label }: { label: string }) => (
  <div className="flex flex-col items-center gap-4">
    <MascotLoader app="badger" src={mascotUrl} size={120} />
    <div className="text-sm text-muted-foreground">{label}</div>
  </div>
);

/** The full-screen wait while Badger opens (account, profiles, language). */
export const LoadingScreen = ({ label }: { label: string }) => (
  <div className="min-h-screen bg-background">
    <div className="container grid min-h-screen place-items-center">
      <MascotWithLabel label={label} />
    </div>
  </div>
);

/**
 * The library's loading screen inside Home and the library page (UX-WAIT-04): the same hovering badger above "Loading
 * library...", shown until the library's load has given its verdict, in place of the empty library.
 */
export const LibraryLoading = ({ label }: { label: string }) => (
  <div className="grid min-h-[60vh] place-items-center" role="status" data-testid="library-loading">
    <MascotWithLabel label={label} />
  </div>
);
