/**
 * The one `react-native` stand-in every vitest file starts from. The real package is Flow source that node cannot parse,
 * so each test replaces it; a hand-rolled mock that lists only what the screen under test uses breaks the whole file the
 * day an import anywhere below it reads one more export at load time (`AppRegistry` from mobile-media-session's
 * headless task, `NativeModules` from mobile-media-volume): vitest then refuses to load the file and its tests vanish.
 *
 * `tests/setup/vitest.setup.ts` registers it for every file. A file that needs its own values spreads it first:
 *   vi.mock("react-native", async () => ({ ...(await import("<rel>/tests/setup/reactNativeMock")).reactNativeBase(), ...mine }))
 * Plain functions only, no `vi.fn`: the config's `mockReset` would wipe their bodies between tests.
 */
const host = (name: string) => name;
const subscription = () => ({ remove: () => undefined });

class NativeEventEmitter {
  addListener() {
    return subscription();
  }
  removeAllListeners() {}
  emit() {}
  listenerCount() {
    return 0;
  }
}

/** `Animated.Value` without the native driver: holds the number a fade or a slide is at. */
class AnimatedValue {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  setValue(value: number) {
    this.value = value;
  }
}
/** An animation that lands on its end value at once when started. */
const animation = (target: AnimatedValue, toValue: number) => ({
  start: (done?: (result: { finished: boolean }) => void) => {
    target.setValue(toValue);
    done?.({ finished: true });
  },
  stop: () => undefined,
});

export function reactNativeBase(): Record<string, unknown> {
  const windowSize = { width: 960, height: 540, scale: 1, fontScale: 1 };
  return {
    ActivityIndicator: host("ActivityIndicator"),
    FlatList: host("FlatList"),
    Image: host("Image"),
    ImageBackground: host("ImageBackground"),
    Modal: host("Modal"),
    Pressable: host("Pressable"),
    SafeAreaView: host("SafeAreaView"),
    ScrollView: host("ScrollView"),
    SectionList: host("SectionList"),
    StatusBar: host("StatusBar"),
    Switch: host("Switch"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    TouchableOpacity: host("TouchableOpacity"),
    TVFocusGuideView: host("TVFocusGuideView"),
    View: host("View"),
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)),
      hairlineWidth: 1,
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Platform: {
      OS: "android",
      isTV: false,
      Version: 34,
      constants: {},
      select: <T,>(choices: { android?: T; native?: T; default?: T }) => choices.android ?? choices.native ?? choices.default,
    },
    Dimensions: { get: () => windowSize, addEventListener: subscription },
    PixelRatio: { get: () => 1, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
    useWindowDimensions: () => windowSize,
    useColorScheme: () => "dark",
    AppRegistry: { registerComponent: () => undefined, registerHeadlessTask: () => undefined },
    AppState: { currentState: "active", addEventListener: subscription },
    DeviceEventEmitter: { addListener: subscription, emit: () => undefined, removeAllListeners: () => undefined },
    NativeEventEmitter,
    NativeModules: {},
    TurboModuleRegistry: { get: () => null, getEnforcing: () => null },
    Alert: { alert: () => undefined },
    BackHandler: { addEventListener: subscription },
    Keyboard: { dismiss: () => undefined, addListener: subscription },
    Linking: { openURL: async () => undefined, addEventListener: subscription, getInitialURL: async () => null },
    Animated: {
      Value: AnimatedValue,
      timing: (target: AnimatedValue, config: { toValue: number }) => animation(target, config.toValue),
      View: host("Animated.View"),
      Image: host("Animated.Image"),
      Text: host("Animated.Text"),
    },
    AccessibilityInfo: {
      isScreenReaderEnabled: async () => false,
      isReduceMotionEnabled: async () => false,
      addEventListener: subscription,
      announceForAccessibility: () => undefined,
    },
    I18nManager: { isRTL: false },
    findNodeHandle: () => null,
  };
}

/** react-native-svg is CommonJS that `require`s the real react-native, out of vi.mock's reach: host stand-ins instead. */
export function reactNativeSvgBase(): Record<string, unknown> {
  const names = [
    "Circle", "ClipPath", "Defs", "Ellipse", "G", "Image", "Line", "LinearGradient", "Mask", "Path", "Pattern", "Polygon",
    "Polyline", "RadialGradient", "Rect", "Stop", "Symbol", "Text", "TSpan", "Use", "SvgXml", "SvgUri", "SvgCss",
  ];
  return { default: host("Svg"), Svg: host("Svg"), ...Object.fromEntries(names.map((name) => [name, host(name)])) };
}

/**
 * lucide-react-native is outside the vite graph: node loads it natively, it imports the real react-native-svg and that
 * the real react-native (Flow: `SyntaxError: Unexpected token 'typeof'`). Every icon name resolves to a host named after
 * it, so a screen that adds an icon (PlayerSubtitleVersion's `Check`, under PlayerScreen) never breaks a file that
 * renders it. `then` stays absent so the module is not mistaken for a promise.
 */
export function lucideBase(): Record<string, unknown> {
  const isIcon = (key: string | symbol): key is string => typeof key === "string" && key !== "then";
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (isIcon(key) ? host(key) : undefined),
    has: (_target, key) => isIcon(key),
  });
}
