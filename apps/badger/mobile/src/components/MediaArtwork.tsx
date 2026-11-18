import React from "react";
import type { ImageErrorEvent, StyleProp, ViewStyle } from "react-native";
import type { ArtworkKind } from "@space/library-db-definition/artworkCopy";
import { MobileArtworkImage } from "@space/mobile-shell/artwork-image";
import { useMediaImageSource } from "../lib/useMediaImage";

type MediaArtworkProps = {
  path: string | null;
  kind: ArtworkKind;
  /** The tile box (size, corners); the picture always fills it. */
  style?: StyleProp<ViewStyle>;
  /** Written under the icon when there is no picture (the title). A face shows the person icon alone. */
  label?: string;
  /** Drawn instead of the icon when there is no picture (a cast face's initials). */
  fallback?: React.ReactNode;
  onImageError?: (event: ImageErrorEvent) => void;
  testID?: string;
};

/**
 * A library title's poster, still or cast face from the user's own copy (`useMediaImageSource`, META-ART-01/02) with
 * UX-WAIT-03's looks: a small spinner while it comes, the picture faded in, an icon with the title when there is none.
 */
export const MediaArtwork = ({ path, kind, style, label, fallback, onImageError, testID }: MediaArtworkProps) => {
  const source = useMediaImageSource(path, kind);
  return (
    <MobileArtworkImage
      key={path ?? ""}
      source={source}
      style={style}
      label={kind === "profile" ? undefined : label}
      icon={kind === "profile" ? "person" : "film"}
      decorative={kind === "backdrop"}
      fallback={fallback}
      onImageError={onImageError}
      testID={testID}
    />
  );
};
