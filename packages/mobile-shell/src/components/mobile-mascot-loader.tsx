import React, { useEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, Image, View, type ImageSourcePropType } from "react-native";
import Svg, { Ellipse, G, Path } from "react-native-svg";
import {
  MASCOT_LOADER_BOX,
  MASCOT_LOADER_OUTLINE,
  MASCOT_LOADER_SAMPLES,
  MASCOT_LOADERS,
  mascotLoaderKeyframes,
  type MascotLoaderApp,
} from "@space/shared/mascotLoader";

type MobileMascotLoaderProps = {
  app: MascotLoaderApp;
  /** The app's mascot picture (`src/assets/mascot.webp`). */
  source: ImageSourcePropType;
  /** Side of the square, dp. */
  size?: number;
};

const INPUT_RANGE = Array.from({ length: MASCOT_LOADER_SAMPLES + 1 }, (_, i) => i / MASCOT_LOADER_SAMPLES);

/**
 * The animated mascot above the loading text of the phone and TV loading screens (UX-WAIT-02), the same motion as the
 * web and desktop (`@space/shared/mascotLoader`). React Native's own Animated on the native driver and
 * react-native-svg for the music notes, both already in every app: no new dependency. Decorative, so hidden from
 * screen readers; the loading text stays the status. Stands still when the system asks for reduced motion.
 */
export const MobileMascotLoader = ({ app, source, size = 120 }: MobileMascotLoaderProps) => {
  const spec = MASCOT_LOADERS[app];
  const k = size / MASCOT_LOADER_BOX;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(
        Animated.timing(progress, { toValue: 1, duration: spec.durationMs, easing: Easing.linear, useNativeDriver: true }),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [progress, spec.durationMs]);

  const layerStyles = useMemo(
    () =>
      mascotLoaderKeyframes(app).map((poses) => {
        const track = (pick: (i: number) => number) =>
          progress.interpolate({ inputRange: INPUT_RANGE, outputRange: poses.map((_, i) => pick(i)) });
        return {
          opacity: track((i) => poses[i]!.opacity),
          transform: [
            { translateX: track((i) => poses[i]!.x * k) },
            { translateY: track((i) => poses[i]!.y * k) },
            {
              rotate: progress.interpolate({
                inputRange: INPUT_RANGE,
                outputRange: poses.map((pose) => `${pose.rotate}deg`),
              }),
            },
            { scaleX: track((i) => poses[i]!.scaleX) },
            { scaleY: track((i) => poses[i]!.scaleY) },
          ],
        };
      }),
    [app, k, progress],
  );

  return (
    <View
      testID={`mascot-loader-${app}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      {spec.layers.map((layer, i) => {
        // Each layer is centred on (0, 0) and moved to its pose; React Native turns and stretches about the centre.
        const w = layer.kind === "mascot" ? layer.width * k : 64 * k;
        const h = layer.kind === "mascot" ? layer.height * k : 64 * k;
        return (
          <Animated.View
            key={layer.id}
            style={[{ position: "absolute", left: -w / 2, top: -h / 2, width: w, height: h }, layerStyles[i]]}
          >
            {layer.kind === "mascot" ? (
              <Image source={source} style={{ width: w, height: h }} resizeMode="contain" />
            ) : (
              <Svg width={w} height={h} viewBox="-32 -32 64 64">
                <G fill={layer.fill} stroke={MASCOT_LOADER_OUTLINE} strokeWidth={3} strokeLinejoin="round">
                  {layer.shapes.map((shape, j) =>
                    shape.kind === "path" ? (
                      <Path key={j} d={shape.d} />
                    ) : (
                      <Ellipse
                        key={j}
                        cx={shape.cx}
                        cy={shape.cy}
                        rx={shape.rx}
                        ry={shape.ry}
                        rotation={shape.rotate}
                        originX={shape.cx}
                        originY={shape.cy}
                      />
                    ),
                  )}
                </G>
              </Svg>
            )}
          </Animated.View>
        );
      })}
    </View>
  );
};
