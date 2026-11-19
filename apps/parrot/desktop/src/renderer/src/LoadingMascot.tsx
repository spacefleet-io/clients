import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/parrot-core/mascot.webp";

/**
 * Parrot's wait while it starts: the nodding parrot with its notes, in the spinner's place (UX-WAIT-02). Decorative;
 * this wait carries no text.
 */
export const LoadingMascot = ({ size = 120 }: { size?: number }) => <MascotLoader app="parrot" src={mascotUrl} size={size} />;

/**
 * The library's loading screen (UX-WAIT-04): the nodding parrot above "Loading library…" in the app's language,
 * shown on Home and the library page until the library's load has given its verdict, in place of the empty library.
 * It fills the page area between the top bar and the player (`min-h-full` of the scrolling `<main>`), so the parrot
 * sits in its middle. The text is the accessible status; the mascot is decorative.
 */
export const LibraryLoading = ({ label }: { label: string }) => (
  <div className="flex min-h-full flex-col items-center justify-center gap-4" role="status" data-testid="library-loading">
    <LoadingMascot />
    <p className="text-sm text-muted-foreground">{label}</p>
  </div>
);
