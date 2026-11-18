/**
 * The site hero's 150 stars on phone and TV (UX-SKY-02), and the still sky (weak phone or the user's choice): those
 * stars and three shooting stars caught mid-flight on the hero's 315 deg path.
 *
 * The stars never move (Chris 2026-11-16: no twinkle): `MobileSkyStars` draws all of them in one react-native-svg view,
 * recorded once, so the screen has nothing to redraw for them while the animated sky (`mobile-star-sky.tsx`) flies its
 * shooting stars. The still sky adds frozen shooting stars as plain Views: no animation, no timers, no listeners.
 */
import React, { memo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { createSkyStars, SKY_COLOR, type SkyStar } from "@space/shared/starSky";
import { MobileShootingStarShape, shootingStarHeadStyle, shootingStarRowStyle } from "./mobile-shooting-star-shape";

/** One sky per app run, like one hero per page load: the still and the animated sky show the same stars. */
export const MOBILE_SKY_STARS: readonly SkyStar[] = createSkyStars();

/** Frozen shooting stars: head position in % of the backdrop and brightness; all on the hero's path angle. */
export const STATIC_SHOOTING_STARS = [
  { x: 56, y: 17, opacity: 0.85 },
  { x: 24, y: 50, opacity: 0.7 },
  { x: 46, y: 82, opacity: 0.6 },
] as const;

/** The 150 stars as one still layer filling its parent: each centred at x% / y%, its size in dp. */
export const MobileSkyStars = memo(() => (
  <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
    {MOBILE_SKY_STARS.map((star, index) => (
      <Circle key={`star-${index}`} cx={`${star.x}%`} cy={`${star.y}%`} r={star.sizePx / 2} fill={SKY_COLOR} opacity={star.opacity} />
    ))}
  </Svg>
));
MobileSkyStars.displayName = "MobileSkyStars";

export const MobileStaticSky = memo(() => (
  <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <MobileSkyStars />
    {STATIC_SHOOTING_STARS.map((star, index) => (
      <View key={`shooting-${index}`} style={[shootingStarHeadStyle, { left: `${star.x}%`, top: `${star.y}%`, opacity: star.opacity }]}>
        <View style={shootingStarRowStyle}>
          <MobileShootingStarShape />
        </View>
      </View>
    ))}
  </View>
));
MobileStaticSky.displayName = "MobileStaticSky";
