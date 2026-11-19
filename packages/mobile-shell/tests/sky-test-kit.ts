/**
 * Fakes for the sky tests: a tiny hook runtime (state and effects that persist
 * across renders of one component), React Native stubs, and a recording
 * `Animated` that reports which animations were started, with what config, and
 * which still run. `kit.animatedAllowed = false` makes every Animated / listener
 * call throw, to prove the still sky never touches them.
 */
// Type-only: the tests mock "react" with this module's hooks, so a runtime import would be circular.
import type React from "react";

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void) };

export type FakeAnim = {
  kind: "timing" | "loop";
  value: FakeValue;
  config?: { toValue: number; duration: number; easing: unknown; useNativeDriver: boolean };
  inner?: FakeAnim;
  running: boolean;
  start: (cb?: (result: { finished: boolean }) => void) => void;
  stop: () => void;
};

export type FakeInterpolation = { parent: FakeValue; config: { inputRange: number[]; outputRange: number[] } };

const boom = (name: string) => {
  throw new Error(`${name} must not run in the still sky`);
};

export const kit = {
  animatedAllowed: true,
  mode: "animated" as "static" | "animated",
  slots: [] as Slot[],
  cursor: 0,
  pending: [] as (() => void)[],
  values: [] as FakeValue[],
  anims: [] as FakeAnim[],
  appState: { current: "active", listeners: new Set<(state: string) => void>() },
  reduceMotion: { enabled: false, listeners: new Set<(enabled: boolean) => void>() },
  keyboard: new Map<string, () => void>(),
  reset() {
    this.animatedAllowed = true;
    this.mode = "animated";
    this.slots = [];
    this.cursor = 0;
    this.pending = [];
    this.values = [];
    this.anims = [];
    this.appState = { current: "active", listeners: new Set() };
    this.reduceMotion = { enabled: false, listeners: new Set() };
    this.keyboard = new Map();
  },
  /** Started animations still running (a loop counts once, through its loop). */
  running() {
    return this.anims.filter((anim) => anim.running && !this.anims.some((outer) => outer.inner === anim));
  },
};

export class FakeValue {
  value: number;
  constructor(value: number) {
    if (!kit.animatedAllowed) boom("Animated.Value");
    this.value = value;
    kit.values.push(this);
  }
  setValue(value: number) {
    this.value = value;
  }
  stopAnimation(cb?: (value: number) => void) {
    for (const anim of kit.anims) if (anim.value === this && anim.running) anim.stop();
    cb?.(this.value);
  }
  interpolate(config: FakeInterpolation["config"]): FakeInterpolation {
    return { parent: this, config };
  }
}

const timing = (value: FakeValue, config: NonNullable<FakeAnim["config"]>): FakeAnim => {
  let done: ((result: { finished: boolean }) => void) | undefined;
  const anim: FakeAnim = {
    kind: "timing",
    value,
    config,
    running: false,
    start: (cb) => {
      done = cb;
      anim.running = true;
      kit.anims.push(anim);
    },
    stop: () => {
      if (!anim.running) return;
      anim.running = false;
      done?.({ finished: false });
    },
  };
  return anim;
};

const loop = (inner: FakeAnim): FakeAnim => {
  const anim: FakeAnim = {
    kind: "loop",
    value: inner.value,
    inner,
    config: inner.config,
    running: false,
    start: () => {
      anim.running = true;
      kit.anims.push(anim);
      inner.start();
    },
    stop: () => {
      anim.running = false;
      inner.stop();
    },
  };
  return anim;
};

const ViewStub = Object.assign((props: unknown) => props, { displayName: "ViewStub" });
const ImageStub = Object.assign((props: unknown) => props, { displayName: "ImageStub" });
const AnimatedViewStub = Object.assign(
  (props: unknown) => {
    if (!kit.animatedAllowed) boom("Animated.View");
    return props;
  },
  { displayName: "AnimatedViewStub" },
);

const SvgStub = Object.assign((props: unknown) => props, { displayName: "SvgStub" });
const CircleStub = Object.assign((props: unknown) => props, { displayName: "CircleStub" });

export const stubs = { ViewStub, ImageStub, AnimatedViewStub, SvgStub, CircleStub };

/** react-native-svg as the sky draws it: one Svg of Circles. */
export const reactNativeSvgFake = { default: SvgStub, Circle: CircleStub };

const guard = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
  ((...args: Parameters<T>) => {
    if (!kit.animatedAllowed) boom(name);
    return fn(...args);
  }) as T;

export const reactNativeFake = {
  View: ViewStub,
  Image: ImageStub,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } },
  Animated: {
    View: AnimatedViewStub,
    Value: FakeValue,
    timing: guard("Animated.timing", timing),
    loop: guard("Animated.loop", loop),
  },
  Easing: { linear: (t: number) => t },
  AppState: {
    get currentState() {
      return kit.appState.current;
    },
    addEventListener: guard("AppState.addEventListener", (_type: string, listener: (state: string) => void) => {
      kit.appState.listeners.add(listener);
      return { remove: () => kit.appState.listeners.delete(listener) };
    }),
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: guard("AccessibilityInfo.isReduceMotionEnabled", () => Promise.resolve(kit.reduceMotion.enabled)),
    addEventListener: guard("AccessibilityInfo.addEventListener", (_type: string, listener: (enabled: boolean) => void) => {
      kit.reduceMotion.listeners.add(listener);
      return { remove: () => kit.reduceMotion.listeners.delete(listener) };
    }),
  },
  Keyboard: {
    addListener: guard("Keyboard.addListener", (type: string, listener: () => void) => {
      kit.keyboard.set(type, listener);
      return { remove: () => kit.keyboard.delete(type) };
    }),
  },
};

/** useState / useEffect that persist across renders of the one component under test. */
export const hookFakes = {
  useState: (initial: unknown) => {
    const slot = (kit.slots[kit.cursor++] ??= { value: typeof initial === "function" ? (initial as () => unknown)() : initial });
    return [slot.value, () => {}];
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = kit.cursor++;
    const prev = kit.slots[index];
    if (prev && deps && prev.deps && deps.every((dep, i) => Object.is(dep, prev.deps![i]))) return;
    kit.slots[index] = { deps };
    kit.pending.push(() => {
      if (typeof prev?.cleanup === "function") prev.cleanup();
      kit.slots[index]!.cleanup = effect();
    });
  },
  useRef: (initial: unknown) => {
    const slot = (kit.slots[kit.cursor++] ??= { value: { current: initial } });
    return slot.value;
  },
  useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = kit.cursor++;
    const prev = kit.slots[index];
    if (prev && deps && prev.deps && deps.every((dep, i) => Object.is(dep, prev.deps![i]))) return prev.value;
    kit.slots[index] = { value: factory(), deps };
    return kit.slots[index]!.value;
  },
  /** The context's default: the sky under test sits in no `MobileSkyLayer` and no theme provider. */
  useContext: (context: { _currentValue: unknown }) => context._currentValue,
  /** The layer claim (`useClaimSkyLayer`) has no layer to claim here: nothing to run. */
  useLayoutEffect: () => {},
};

/** Renders a (memo) function component with the fake hooks and commits its effects. */
export const render = (component: unknown, props: Record<string, unknown>): React.ReactNode => {
  const fn = (typeof component === "object" && component !== null && "type" in component ? (component as { type: unknown }).type : component) as (
    p: Record<string, unknown>,
  ) => React.ReactNode;
  kit.cursor = 0;
  const out = fn(props);
  const effects = kit.pending;
  kit.pending = [];
  for (const run of effects) run();
  return out;
};

/** Runs every effect cleanup, as an unmount does. */
export const unmount = () => {
  for (const slot of kit.slots) if (typeof slot?.cleanup === "function") slot.cleanup();
};

export type El = { type: unknown; props: { children?: React.ReactNode; style?: unknown } };

/** Every element of a rendered tree, expanding the function components that were not stubbed (no hooks inside them). */
export const walk = (node: React.ReactNode, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node !== "object" || node === null || !("$$typeof" in node) || !("props" in node)) return out;
  const el = node as unknown as El;
  out.push(el);
  const type = el.type as { type?: unknown } | ((props: unknown) => React.ReactNode);
  const inner = typeof type === "object" && type !== null && "type" in type ? (type.type as (props: unknown) => React.ReactNode) : type;
  if (typeof inner === "function" && !Object.values(stubs).includes(inner as never)) walk(inner(el.props), out);
  else walk(el.props.children, out);
  return out;
};

/** Flat style of an element (arrays merged). */
export const flatStyle = (el: El): Record<string, unknown> =>
  Object.assign({}, ...([el.props.style].flat(Infinity as 1) as Record<string, unknown>[]).filter(Boolean));
