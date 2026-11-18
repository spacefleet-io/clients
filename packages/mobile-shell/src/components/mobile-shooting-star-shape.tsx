/// <reference path="../assets.d.ts" />
import React, { memo } from "react";
import { Image, StyleSheet } from "react-native";
import { SKY_SHOOTING_HEAD_PX, SKY_SHOOTING_ROTATE_DEG } from "@space/shared/starSky";
import shootingStarSource from "./assets/shooting-star.png";
import { SHOOTING_STAR_HEAD_X, SHOOTING_STAR_HEAD_Y, SHOOTING_STAR_IMAGE_HEIGHT, SHOOTING_STAR_IMAGE_WIDTH } from "./mobile-shooting-star-metrics";

/**
 * A shooting star: one pre-rendered picture (glow head + gradient tail, see
 * `mobile-shooting-star-metrics.ts`) drawn along +x from its head. The flying
 * star animates a wrapper's transform and opacity, the still sky draws it
 * frozen: nothing is drawn per frame.
 */
export const MobileShootingStarShape = memo(() => <Image source={shootingStarSource} style={styles.image} fadeDuration={0} />);
MobileShootingStarShape.displayName = "MobileShootingStarShape";

/**
 * The hero's head box (2 px), rotated like the hero's path: the picture's +x
 * axis (the tail) points up and to the right, a translateX < 0 inside it moves
 * the head toward the lower left. Rotating the head box turns everything about
 * the head, as the CSS `rotate()` does. Place it with left/top or right/top.
 */
export const shootingStarHeadStyle = {
  position: "absolute",
  width: SKY_SHOOTING_HEAD_PX,
  height: SKY_SHOOTING_HEAD_PX,
  transform: [{ rotate: `${SKY_SHOOTING_ROTATE_DEG}deg` }],
} as const;

/** Box that holds the shape inside the head box, the picture's head on the head box's centre. */
export const shootingStarRowStyle = {
  position: "absolute",
  left: SKY_SHOOTING_HEAD_PX / 2 - SHOOTING_STAR_HEAD_X,
  top: SKY_SHOOTING_HEAD_PX / 2 - SHOOTING_STAR_HEAD_Y,
  width: SHOOTING_STAR_IMAGE_WIDTH,
  height: SHOOTING_STAR_IMAGE_HEIGHT,
} as const;

const styles = StyleSheet.create({
  image: { width: SHOOTING_STAR_IMAGE_WIDTH, height: SHOOTING_STAR_IMAGE_HEIGHT },
});
