// The page stack's context (PAR-TV-04..09): the shell (`TvMainShell`) keeps the stack of open pages (`tvModel`) and
// hands every screen `push` and `pop`. Back closes the topmost page (PAR-TV-10).
import { createContext, useContext } from "react";
import { usePlayWith } from "../state/usePlay";
import type { TvPage } from "./tvModel";

export type TvPages = {
  push: (page: TvPage) => void;
  pop: () => void;
};

export const TvPagesContext = createContext<TvPages>({ push: () => undefined, pop: () => undefined });

export const useTvPages = (): TvPages => useContext(TvPagesContext);

/** `usePlay` for the TV: a song started from any screen opens Now playing (PAR-TV-07). */
export const useTvPlay = () => {
  const { push } = useTvPages();
  return usePlayWith(() => push({ kind: "nowPlaying" }));
};
