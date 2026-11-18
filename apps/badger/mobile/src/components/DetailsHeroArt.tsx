import { StyleSheet } from "react-native";
import Svg, { Defs, Image as SvgImage, LinearGradient, Mask, Rect, Stop } from "react-native-svg";
import { HERO_FADE_STOPS } from "../lib/phoneDetails";
import { SVG_IMAGE_MASK_BOX } from "../lib/svgImageMask";
import { theme } from "../theme/theme";

/**
 * The title page hero's artwork (UX-PHONE-04): the picture edge to edge, fading out at the bottom into the sky, or a plain
 * surface fading the same way while the title has no picture.
 */
export const DetailsHeroArt = ({ uri }: { uri: string | null }) => (
  <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
    <Defs>
      <LinearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1">
        {HERO_FADE_STOPS.map((stop) => (
          <Stop key={stop.offset} offset={stop.offset} stopColor="#fff" stopOpacity={stop.opacity} />
        ))}
      </LinearGradient>
      <Mask id="heroMask" {...SVG_IMAGE_MASK_BOX}>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#heroFade)" />
      </Mask>
    </Defs>
    {uri ? (
      <SvgImage
        testID="details-poster"
        href={{ uri }}
        x="0"
        y="0"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        mask="url(#heroMask)"
      />
    ) : (
      <Rect x="0" y="0" width="100%" height="100%" fill={theme.colors.surface} mask="url(#heroMask)" />
    )}
  </Svg>
);
