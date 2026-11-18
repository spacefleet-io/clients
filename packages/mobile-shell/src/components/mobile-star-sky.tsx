/**
 * The site hero's star sky on phone and TV (UX-SKY-02): its 150 stars, still
 * (one react-native-svg layer drawn once, `MobileSkyStars`), and 3 shooting
 * stars looping on the 315 deg path, every number from `@space/shared/starSky`.
 * The apps' stars do not twinkle (Chris 2026-11-16: it slows the device down);
 * only the website twinkles. React Native core `Animated` with the native
 * driver (no Reanimated: Parrot mobile can mount this sky without it): every
 * loop runs on the UI thread, JS only starts and stops them.
 *
 * Gate (UX-SKY-01, `createSkyMotionGate`) moves only the shooting stars: live
 * runs them; still (a finger, a scroll or the keyboard, then 5 s of quiet) and
 * off (paused shell, app in the background, reduced motion) hide them. Back to
 * live, each shooting star starts again after its delay. Shooting stars fly
 * anywhere, like the site's, and pass behind opaque content.
 */
import React, { memo, useEffect, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Keyboard, StyleSheet, View } from "react-native";
import {
  createSkyMotionGate,
  createSkyShootingStars,
  SKY_SHOOTING_OPACITY_KEYS,
  SKY_SHOOTING_TRAVEL_PX,
  type SkyMotion,
  type SkyShootingStar,
} from "@space/shared/starSky";
import { MobileShootingStarShape, shootingStarHeadStyle, shootingStarRowStyle } from "./mobile-shooting-star-shape";
import type { SkyCoverRegistry } from "./mobile-sky-covers";
import { MobileSkyStars } from "./mobile-static-sky";
import type { UserInputSignal } from "./mobile-user-input";

export type MobileBackdropComets = {
  /** Touch input of the screen root: a held finger holds the sky still, release restarts the quiet period. */
  input: UserInputSignal;
  /** Scrolls in motion of the screen (and the TV remote): one in motion holds the sky still. */
  covers: SkyCoverRegistry;
};

export type MobileStarSkyProps = {
  /** True while something covers the shell (Player, details): the sky is off. It is also off while AppState is not "active". */
  paused?: boolean;
  /** Input of the screen; enables the shooting stars. Without it the stars stand still and nothing flies. */
  comets?: MobileBackdropComets;
};

type SkyLoop = {
  progress: Animated.Value;
  /** Bumped on every start and stop: a late callback of an older run does nothing. */
  epoch: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  anim: Animated.CompositeAnimation | undefined;
};

export type SkyComet = SkyLoop & {
  star: SkyShootingStar;
  opacity: Animated.AnimatedInterpolation<number>;
  translateX: Animated.AnimatedInterpolation<number>;
};

export type StarSkyAnimations = {
  comets: SkyComet[];
  /** Follows the gate: live flies the shooting stars, still and off hide them. */
  apply: (motion: SkyMotion) => void;
  /** Stops every loop and timer. */
  dispose: () => void;
};

const newLoop = (): SkyLoop => ({ progress: new Animated.Value(0), epoch: 0, timer: undefined, anim: undefined });

const stopLoop = (loop: SkyLoop) => {
  loop.epoch += 1;
  clearTimeout(loop.timer);
  loop.timer = undefined;
  loop.anim?.stop();
  loop.anim = undefined;
};

const runForever = (loop: SkyLoop, durationMs: number) => {
  loop.progress.setValue(0);
  loop.anim = Animated.loop(Animated.timing(loop.progress, { toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: true }));
  loop.anim.start();
};

/** The animated values of one sky (the shooting stars only); React-free so the gate wiring can be tested on its own. */
export const createStarSkyAnimations = (shootingStars: readonly SkyShootingStar[]): StarSkyAnimations => {
  const comets: SkyComet[] = shootingStars.map((star) => {
    const loop = newLoop();
    return {
      ...loop,
      star,
      opacity: loop.progress.interpolate({
        inputRange: SKY_SHOOTING_OPACITY_KEYS.map(([p]) => p),
        outputRange: SKY_SHOOTING_OPACITY_KEYS.map(([, o]) => o),
      }),
      translateX: loop.progress.interpolate({ inputRange: [0, 1], outputRange: [0, -SKY_SHOOTING_TRAVEL_PX] }),
    };
  });

  const launchComet = (comet: SkyComet) => {
    if (comet.anim || comet.timer !== undefined) return;
    comet.epoch += 1;
    const epoch = comet.epoch;
    comet.progress.setValue(0);
    comet.timer = setTimeout(() => {
      comet.timer = undefined;
      if (epoch === comet.epoch) runForever(comet, comet.star.durationS * 1000);
    }, comet.star.delayS * 1000);
  };

  const groundComet = (comet: SkyComet) => {
    stopLoop(comet);
    // Progress 0 is opacity 0: hidden until it flies again.
    comet.progress.setValue(0);
  };

  return {
    comets,
    apply: (motion) => {
      if (motion === "live") comets.forEach(launchComet);
      else comets.forEach(groundComet);
    },
    dispose: () => comets.forEach(stopLoop),
  };
};

const Comet = memo(({ comet }: { comet: SkyComet }) => (
  // The head box sits at the hero's top% / right% (its right edge on right%), rotated about the head.
  <View style={[shootingStarHeadStyle, { top: `${comet.star.top}%`, right: `${comet.star.right}%` }]}>
    <Animated.View style={[shootingStarRowStyle, { opacity: comet.opacity, transform: [{ translateX: comet.translateX }] }]} renderToHardwareTextureAndroid>
      <MobileShootingStarShape />
    </Animated.View>
  </View>
));
Comet.displayName = "Comet";

export const MobileStarSky = memo(({ paused, comets }: MobileStarSkyProps) => {
  const [sky] = useState(() => createStarSkyAnimations(comets ? createSkyShootingStars() : []));
  const [gate] = useState(() =>
    createSkyMotionGate({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      onChange: sky.apply,
    }),
  );
  const [blockers] = useState(() => {
    // Off until the OS said whether reduced motion is on.
    const state = { paused: Boolean(paused), background: AppState.currentState !== "active", reduceMotion: true };
    return { state, sync: () => gate.setBlocked(state.paused || state.background || state.reduceMotion) };
  });

  useEffect(
    () => () => {
      gate.dispose();
      sky.dispose();
    },
    [gate, sky],
  );

  useEffect(() => {
    blockers.state.paused = Boolean(paused);
    blockers.sync();
  }, [paused, blockers]);

  useEffect(() => {
    let mounted = true;
    const appState = AppState.addEventListener("change", (next) => {
      blockers.state.background = next !== "active";
      blockers.sync();
    });
    const setReduceMotion = (enabled: boolean) => {
      if (!mounted) return;
      blockers.state.reduceMotion = enabled;
      blockers.sync();
    };
    const reduceMotion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion, () => setReduceMotion(false));
    return () => {
      mounted = false;
      appState.remove();
      reduceMotion.remove();
    };
  }, [blockers]);

  useEffect(() => {
    if (!comets) return undefined;
    let touchHeld = false;
    let keyboardShown = false;
    let scrolling = comets.covers.isScrolling();
    // Every input source reports transitions only; the gate restarts the quiet period on each one.
    const sync = () => gate.setInputHeld(touchHeld || keyboardShown || scrolling);
    sync();
    const unsubscribe = comets.input.subscribe((held) => {
      touchHeld = held;
      sync();
    });
    const unsubscribeScroll = comets.covers.subscribeScrolling((next) => {
      scrolling = next;
      sync();
    });
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      keyboardShown = true;
      sync();
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      keyboardShown = false;
      sync();
    });
    return () => {
      unsubscribe();
      unsubscribeScroll();
      shown.remove();
      hidden.remove();
    };
  }, [comets, gate]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <MobileSkyStars />
      {sky.comets.map((comet, index) => (
        <Comet key={`comet-${index}`} comet={comet} />
      ))}
    </View>
  );
});
MobileStarSky.displayName = "MobileStarSky";
