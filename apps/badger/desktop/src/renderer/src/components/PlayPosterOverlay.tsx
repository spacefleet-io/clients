import { useTranslation } from "react-i18next";
import { PosterPlayOverlay } from "@space/ui/poster-play-overlay";

type PlayPosterOverlayProps = {
  mediaId: string;
  /** Pinned-visible while this tile's media is launching (overrides hover). */
  pending: boolean;
  /** Show the spinner once the launch crosses the spinner-delay threshold. */
  spinnerVisible: boolean;
  onPlay: (mediaId: string) => void;
};

/**
 * Badger's hover Play on a media poster: the shared {@link PosterPlayOverlay} (also on Parrot's covers) with Badger's
 * texts, pinned visible while the tile's media is launching. Shared across the Home, Media library, and Playlists poster
 * grids; pair with {@link import("@/lib/useInlinePlayback").useInlinePlayback}.
 *
 * Render this inside the poster's `relative aspect-[2/3]` container so the
 * `inset-0` backdrop covers only the artwork, not the title block beneath it.
 * The `card-play-overlay` testid is load-bearing — playback.e2e's cold-start
 * case clicks it by selector.
 */
export default function PlayPosterOverlay({ mediaId, pending, spinnerVisible, onPlay }: PlayPosterOverlayProps) {
  const { t } = useTranslation();
  return (
    <PosterPlayOverlay
      label={t("library.play")}
      onPlay={() => onPlay(mediaId)}
      pinned={pending}
      spinnerVisible={spinnerVisible}
      spinnerLabel={t("player.launching")}
      rounded=""
      mediaId={mediaId}
    />
  );
}
