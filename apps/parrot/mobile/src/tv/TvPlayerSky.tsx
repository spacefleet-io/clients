// Parrot TV's sky (UX-SKY-01, UX-SKY-02): the family's `TvSky`, whose shooting stars never fly while music plays, as on
// Parrot's phone screens (`ParrotSky`). Its own component so the player poll re-renders only the sky, not the shell.
import React, { type ReactNode } from "react";
import { TvSky } from "@space/mobile-shell/tv/TvSky";
import { usePlayerState } from "../state/usePlayerState";

export const TvPlayerSky = ({ children }: { children: ReactNode }) => {
  const playing = usePlayerState(1000)?.playing ?? false;
  return (
    <TvSky active paused={playing}>
      {children}
    </TvSky>
  );
};
