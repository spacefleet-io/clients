import { NEBULA_FADE_AT } from "@space/shared/skyNebula";
import { memo } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";
import { useMobileShellTheme } from "../theme";

/**
 * One glow of an app's nebula: an ellipse of `color` at `opacity` in its middle, fading to nothing at its edge.
 * `x`/`rx` are fractions of the screen's width and `y`/`ry` of its height (the centre may lie off screen), so the glow
 * covers the same share of a phone or TV screen as of the desktop window (`mobileNebulaSpots`).
 */
export type MobileNebulaSpot = { x: number; y: number; rx: number; ry: number; color: string; opacity: number };

/**
 * Paints the theme's nebula (`theme.nebula`), if it has one, full screen under the star field: one SVG radial gradient
 * per glow, fading linearly to nothing at NEBULA_FADE_AT of its radius like the web's CSS gradient (UX-SKY-03). Drawn
 * once, so it costs nothing after the first frame (UX-SKY-01).
 */
export const MobileNebula = memo(function MobileNebula() {
  const { nebula } = useMobileShellTheme();
  const { width, height } = useWindowDimensions();
  if (!nebula || nebula.length === 0) return null;
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={width} height={height}>
      <Defs>
        {nebula.map((spot, index) => (
          <RadialGradient key={index} id={`nebula-${index}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={spot.color} stopOpacity={spot.opacity} />
            <Stop offset={NEBULA_FADE_AT} stopColor={spot.color} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {nebula.map((spot, index) => (
        <Ellipse
          key={index}
          cx={spot.x * width}
          cy={spot.y * height}
          rx={spot.rx * width}
          ry={spot.ry * height}
          fill={`url(#nebula-${index})`}
        />
      ))}
    </Svg>
  );
});
