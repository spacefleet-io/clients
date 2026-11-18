import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/ui/badger/mascot.webp";

/**
 * The full-screen wait while Badger opens (account, profiles, the library's first load): the hovering badger above the
 * loading text (UX-WAIT-02). The text stays the accessible status; the mascot is decorative.
 */
export const LoadingScreen = ({ label }: { label: string }) => (
  <div className="min-h-screen bg-background">
    <div className="container grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-4">
        <MascotLoader app="badger" src={mascotUrl} size={120} />
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  </div>
);
