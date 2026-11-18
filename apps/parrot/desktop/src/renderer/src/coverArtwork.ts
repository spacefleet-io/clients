/**
 * The system media panel (PLAY-OSMEDIA-01) only takes a picture held by the window itself (`blob:`), never the
 * loopback address main serves covers from. This reads the large cover main serves and keeps it as one blob: URL; the
 * previous one is released when another song's cover replaces it, so at most one picture is held.
 */
export const createCoverArtwork = (input: {
  fetch: (url: string) => Promise<Response>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}) => {
  let held: { coverUrl: string; artwork: Promise<string | null> } | null = null;
  return (coverUrl: string): Promise<string | null> => {
    if (held?.coverUrl === coverUrl) return held.artwork;
    const previous = held;
    const artwork = input
      .fetch(coverUrl)
      .then(async (response) => (response.ok ? input.createObjectURL(await response.blob()) : null))
      .catch(() => null);
    held = { coverUrl, artwork };
    void previous?.artwork.then((url) => url && input.revokeObjectURL(url));
    return artwork;
  };
};

export const coverArtwork = createCoverArtwork({
  fetch: (url) => fetch(url),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});
