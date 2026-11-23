import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/parrot-core/mascot.webp";

/**
 * Parrot's wait while it starts and while the library opens: the nodding parrot with its notes, in the spinner's
 * place (UX-WAIT-02). Decorative; these waits carry no text.
 */
export const LoadingMascot = ({ size = 120 }: { size?: number }) => <MascotLoader app="parrot" src={mascotUrl} size={size} />;
