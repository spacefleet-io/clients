import { memo, useEffect, useState } from "react";
import { ArtworkImage } from "@space/ui/artwork-image";
import type { ArtworkSource } from "@space/shared/artworkImage";
import { onMetadataTicketsAvailable, resolveArtwork } from "@/lib/metadataTickets";
import type { ImageKind } from "@space/metadata-client";

type ImportCandidateImageProps = {
  path: string | null;
  alt: string;
  kind?: ImageKind;
  className?: string;
};

/**
 * Artwork of a match candidate while the user picks what a file is, before it is in the library. Import is the one
 * time the metadata service is asked for artwork (META-ART-02); the answer is cached on disk, so the copy made when
 * the title is added reuses it. Library titles use `MediaImage`, which shows only the user's own copy. With no ticket
 * yet, it asks again once tickets arrive (the spinner stays meanwhile); no picture, or a failed lookup, shows the
 * fallback with the title (UX-WAIT-03).
 */
function ImportCandidateImageInner({ path, alt, kind = "poster", className }: ImportCandidateImageProps) {
  const [source, setSource] = useState<ArtworkSource>({ kind: path ? "pending" : "none" });

  useEffect(() => {
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    setSource({ kind: path ? "pending" : "none" });
    if (!path) return () => undefined;
    const attempt = (waitForTickets: boolean) => {
      void resolveArtwork(kind, path).then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "ok") setSource({ kind: "url", url: outcome.url });
        else if (outcome.status === "no_ticket" && waitForTickets) {
          stopWaiting = onMetadataTicketsAvailable(() => {
            stopWaiting?.();
            stopWaiting = undefined;
            attempt(false);
          });
        } else setSource({ kind: "none" });
      });
    };
    attempt(true);
    return () => {
      cancelled = true;
      stopWaiting?.();
    };
  }, [path, kind]);

  return <ArtworkImage key={path ?? ""} source={source} alt={alt} label={alt || undefined} className={className} />;
}

export default memo(ImportCandidateImageInner);
