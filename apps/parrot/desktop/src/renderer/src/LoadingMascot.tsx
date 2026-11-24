import { LibraryLoading as SharedLibraryLoading, MascotLoading } from "@space/ui/library-loading";
import mascotUrl from "@space/parrot-core/mascot.webp";

/** Parrot's wait while it starts: the nodding parrot with its notes, in the spinner's place (UX-WAIT-02); no text. */
export const LoadingMascot = () => <MascotLoading app="parrot" src={mascotUrl} />;

/**
 * UX-WAIT-04: Home's and the library page's wait. It fills the page area between the top bar and the player
 * (`min-h-full` of the scrolling `<main>`), so the parrot sits in its middle.
 */
export const LibraryLoading = ({ label }: { label: string }) => (
  <SharedLibraryLoading app="parrot" src={mascotUrl} label={label} className="flex min-h-full flex-col items-center justify-center" />
);
