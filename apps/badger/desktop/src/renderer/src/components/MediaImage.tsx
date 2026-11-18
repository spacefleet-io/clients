import { memo } from "react";
import { ArtworkImage } from "@space/ui/artwork-image";
import { useMediaImageSource } from "@/lib/useMediaImage";
import type { ImageKind } from "@space/metadata-client";

type MediaImageProps = {
  path: string | null;
  alt: string;
  /** Which artwork the path names. Default: poster. A profile falls back to a person icon; a backdrop only fades in. */
  kind?: ImageKind;
  /** Classes of the tile box; the picture always covers it. */
  className?: string;
  /** Written under the icon when there is no picture (the title). Defaults to `alt`. */
  label?: string;
};

/** A library title's poster, still, face or backdrop from the user's own copy, with UX-WAIT-03's loading looks. */
function MediaImageInner({ path, alt, kind = "poster", className, label = alt }: MediaImageProps) {
  const source = useMediaImageSource(path, kind);
  return (
    <ArtworkImage
      key={path ?? ""}
      source={source}
      alt={alt}
      className={className}
      label={kind === "profile" ? undefined : label || undefined}
      icon={kind === "profile" ? "person" : "film"}
      decorative={kind === "backdrop"}
    />
  );
}

export default memo(MediaImageInner);
