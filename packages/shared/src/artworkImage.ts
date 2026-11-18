/**
 * The three looks of a poster, still or face tile while its picture comes in (UX-WAIT-03), shared by the web and
 * desktop tile (`@space/ui/artwork-image`) and the phone and TV tile (`@space/mobile-shell/artwork-image`):
 *
 * - `loading`: the placeholder with a small spinner, while the picture is being fetched or drawn;
 * - `loaded`: the picture, faded in;
 * - `failed`: a deliberate fallback (an icon and the title), when there is no picture, it would not load, or the
 *   fetch took longer than `ARTWORK_LOAD_TIMEOUT_MS`.
 *
 * Each app's artwork hook says where the picture stands (`ArtworkSource`); the tile feeds that and its image view's
 * load and error events through `artworkReducer`. Pure, so every app runs the same transitions.
 */

/** What an app's artwork hook knows about a tile's picture. */
export type ArtworkSource =
  /** Being fetched (read from the device, downloaded, decrypted) or still to be copied into the user's storage. */
  | { kind: "pending" }
  /** Ready to draw at `url` (a file, blob or data address on this device). */
  | { kind: "url"; url: string }
  /** No picture: the title has none, or the fetch failed. */
  | { kind: "none" };

export type ArtworkPhase = "loading" | "loaded" | "failed";

export type ArtworkState = {
  phase: ArtworkPhase;
  /** The picture the image view draws (hidden until it has loaded), or null while there is none. */
  url: string | null;
};

export type ArtworkEvent =
  /** The hook's answer changed. */
  | { type: "source"; source: ArtworkSource }
  /** The image view finished drawing `url`. */
  | { type: "load"; url: string }
  /** The image view could not draw `url`. */
  | { type: "error"; url: string }
  /** `ARTWORK_LOAD_TIMEOUT_MS` passed while the picture was still being fetched. */
  | { type: "timeout" };

/**
 * How long a tile waits for its picture to be fetched before it shows the fallback. The pictures are the user's own
 * copies, read from the device or from storage and decrypted: a cache hit is instant and a download takes a few
 * seconds, so a wait past this is a stall, and the title reads better than a spinner that never ends.
 */
export const ARTWORK_LOAD_TIMEOUT_MS = 15_000;

/**
 * How long the spinner waits before it shows: a picture already on the device draws within a frame or two, and a
 * spinner flashing on every tile while scrolling would read as the app working when it is not (UX-WAIT-01).
 */
export const ARTWORK_SPINNER_DELAY_MS = 150;

/** The look a tile starts in for `source`. */
export const artworkStateFor = (source: ArtworkSource): ArtworkState =>
  source.kind === "none" ? { phase: "failed", url: null } : { phase: "loading", url: source.kind === "url" ? source.url : null };

/**
 * The next look. A picture that arrives after the tile gave up still fades in over the fallback (no spinner again);
 * load and error events of a picture the tile no longer shows are ignored.
 */
export const artworkReducer = (state: ArtworkState, event: ArtworkEvent): ArtworkState => {
  switch (event.type) {
    case "source": {
      const { source } = event;
      if (source.kind === "url") {
        if (source.url === state.url) return state;
        return { phase: state.phase === "failed" ? "failed" : "loading", url: source.url };
      }
      if (source.kind === "none") return state.phase === "failed" && state.url === null ? state : { phase: "failed", url: null };
      // Pending: a new fetch began (a new path, a new session); a tile that already gave up keeps its fallback.
      if (state.phase === "failed") return state.url === null ? state : { phase: "failed", url: null };
      return { phase: "loading", url: null };
    }
    case "load":
      return event.url === state.url && state.phase !== "loaded" ? { phase: "loaded", url: state.url } : state;
    case "error":
      return event.url === state.url ? { phase: "failed", url: null } : state;
    case "timeout":
      // Only a fetch that has not answered times out: a picture on the device already has its address and draws
      // (or errors) on its own, and an off-screen web tile may hold its decode until it is scrolled to.
      return state.phase === "loading" && state.url === null ? { phase: "failed", url: null } : state;
  }
};

/** Whether the tile should run the timeout clock now. */
export const artworkAwaitsSource = (state: ArtworkState): boolean => state.phase === "loading" && state.url === null;
