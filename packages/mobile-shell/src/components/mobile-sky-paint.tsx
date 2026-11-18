/**
 * Paints the sky: the app's nebula (UX-SKY-03) under the site hero's star sky (UX-SKY-02). Animated sky:
 * `MobileStarSky`, the still stars and, when the screen passes `comets`, the hero's three looping shooting stars, held
 * still while the user interacts and off while paused, backgrounded or with reduced motion (UX-SKY-01). Still sky (weak
 * phone or the user's choice, see `useMobileSkyMode`): `MobileStaticSky`, the same stars and frozen shooting stars,
 * nothing moves. Drawn by `MobileSkyLayer` and `MobileAppBackdrop`.
 */
import React, { memo } from "react";
import { useMobileSkyMode } from "./mobile-sky-mode";
import { MobileStarSky, type MobileStarSkyProps } from "./mobile-star-sky";
import { MobileStaticSky } from "./mobile-static-sky";
import { MobileNebula } from "./mobile-nebula";

function SkyPaint({ paused, comets }: MobileStarSkyProps) {
  const mode = useMobileSkyMode();
  return (
    <>
      <MobileNebula />
      {mode === "static" ? (
        <MobileStaticSky />
      ) : (
        // The shooting stars are made once per sky: a screen that starts or stops passing `comets` gets a new sky.
        <MobileStarSky key={comets ? "comets" : "stars"} paused={paused} comets={comets} />
      )}
    </>
  );
}

export const MobileSkyPaint = memo(SkyPaint);
