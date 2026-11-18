// PAR-META-20: the albums and artists the phone's automatic cover and photo passes still have to ask (the `onWaiting`
// of `runParrotAutoAlbumCovers` and `runParrotAutoArtistPictures`). Their pictures shimmer instead of showing the drawn
// picture, which means "no cover" or "no photo": loading never looks like none.

const createWaitingSet = () => {
  const waiting = new Set<string>();
  const listeners = new Set<() => void>();
  const self = {
    has: (id: string | null | undefined): boolean => (id ? waiting.has(id) : false),
    /** The pass's current list (empty at its end). */
    set: (ids: readonly string[]) => {
      const next = new Set(ids);
      if (next.size === waiting.size && [...next].every((id) => waiting.has(id))) return;
      waiting.clear();
      for (const id of next) waiting.add(id);
      for (const listener of [...listeners]) listener();
    },
    clear: () => self.set([]),
    /** Called after every change; returns the unsubscribe. */
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return self;
};

/** Albums the cover pass still has to ask. */
export const albumCoversWaiting = createWaitingSet();
/** Artists the photo pass still has to ask. */
export const artistPicturesWaiting = createWaitingSet();
