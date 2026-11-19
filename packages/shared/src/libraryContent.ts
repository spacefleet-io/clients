/**
 * What a library page shows (UX-WAIT-04): the user's titles or songs, the loading screen, or the empty library.
 *
 * The empty library is a verdict, never a default. "Nothing listed yet" while the library opens, downloads or syncs
 * is `loading` (the app's loading screen: its mascot above "Loading library..."), and only a load that has finished
 * with nothing in it (a saved copy that says empty AND the server's answer that confirms it, or the server's answer
 * alone when nothing is saved) is `empty`. Anything listed is `ready` at once, so a saved library paints before the
 * refresh behind it ends.
 */
export type LibraryContent = "loading" | "ready" | "empty";

export const libraryContent = (input: {
  /** Titles (Badger) or albums / songs (Parrot) the app can list right now. */
  itemCount: number;
  /**
   * The load has given its verdict: the server's library was read (or the server said there is none), or no answer
   * can come (offline with the saved copy, a load that failed). False while the first load or its refresh still runs.
   */
  settled: boolean;
}): LibraryContent => {
  if (input.itemCount > 0) return "ready";
  return input.settled ? "empty" : "loading";
};
