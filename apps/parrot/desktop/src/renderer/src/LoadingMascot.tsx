import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/parrot-core/mascot.webp";

/**
 * Parrot's wait while it starts: the nodding parrot with its notes, in the spinner's place (UX-WAIT-02). Decorative;
 * this wait carries no text.
 */
export const LoadingMascot = ({ size = 120 }: { size?: number }) => <MascotLoader app="parrot" src={mascotUrl} size={size} />;

/**
 * The library's loading screen (UX-WAIT-04): the nodding parrot above "Loading library..." in the app's language,
 * shown on Home and the library page until the library's load has given its verdict, in place of the empty library.
 * The text is the accessible status; the mascot is decorative.
 */
export const LibraryLoading = ({ label }: { label: string }) => (
  <div className="flex flex-col items-center gap-4 py-16" role="status" data-testid="library-loading">
    <LoadingMascot />
    <p className="text-sm text-muted-foreground">{label}</p>
  </div>
);
