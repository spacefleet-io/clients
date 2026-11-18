import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useLibraryShell } from "@/lib/libraryContext";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "library-route" });

/**
 * UX-LIBTAB-01: an empty library cannot be opened, nor its playlists. The top bar greys Library and Playlists out; a
 * link that still lands on either page (Add media, a toast, a restored route) goes to Home instead. While the library
 * loads or failed to load, the page opens as before (it shows the load error).
 */
export const RequireLibraryMedia = ({ children }: { children: ReactNode }) => {
  const { mediaCount, loading, error } = useLibraryShell();
  if (!loading && !error && mediaCount === 0) {
    log.info("library empty: back to home");
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
};
