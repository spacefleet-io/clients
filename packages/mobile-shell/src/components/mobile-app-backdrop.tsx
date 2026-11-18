/**
 * The sky behind the mobile and TV shells (UX-SKY-02), painted by a screen that drives it itself: its own `paused`
 * and its `comets` (the hero's shooting stars). It claims the nearest `MobileSkyLayer`, which then leaves the sky to
 * it, so a screen never runs two star fields (UX-SKY-01, UX-SKY-04).
 */
import React, { memo } from "react";
import type { MobileStarSkyProps } from "./mobile-star-sky";
import { useClaimSkyLayer } from "./mobile-sky-layer";
import { MobileSkyPaint } from "./mobile-sky-paint";

export type { MobileBackdropComets } from "./mobile-star-sky";

function MobileAppBackdrop({ paused, comets }: MobileStarSkyProps) {
  useClaimSkyLayer();
  return <MobileSkyPaint paused={paused} comets={comets} />;
}

export default memo(MobileAppBackdrop);
