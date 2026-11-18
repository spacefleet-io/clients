// UX-SHEET-01: the one bottom sheet of the phone apps (Badger and Parrot). It rises over the whole app (tab bar
// included). The backdrop stays put and fades in as the sheet slides up, then fades out as it slides away, in step with a
// drag. The handle row and the title under it (a 44 pt zone) drag the sheet down: past a distance or on a flick it
// closes, otherwise it springs back. A list inside it (`MobileSheetScrollView`) hands a downward drag to the sheet while
// it is scrolled to its top. Its rounded top corners are clear: what shows there is the dimmed screen behind it.
import React, { createContext, forwardRef, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useMobileShellTheme } from "../theme";
import { MobileRenderBoundary } from "./mobile-render-boundary";
import {
  SHEET_BACKDROP_COLOR,
  SHEET_CLOSE_MS,
  SHEET_HANDLE_HEIGHT,
  SHEET_OPEN_MS,
  SHEET_SHARE,
  sheetBackdropInterpolation,
  sheetDragOffset,
  shouldCloseSheet,
} from "./mobile-bottom-sheet-motion";

/** The builder-API pan (`Gesture.Pan()`); the package's root `PanGesture` type names the v3 hook gesture instead. */
export type MobileDismissPan = ReturnType<typeof Gesture.Pan>;

export type MobileBottomSheetProps = {
  /** Shown while true. Turning it false slides the sheet out, then takes it away. */
  visible: boolean;
  /** The person closed the sheet (backdrop, Back, a drag or `useMobileSheetClose`): set `visible` false. */
  onClose: () => void;
  /** The sheet is out of sight, whatever closed it. */
  onClosed?: () => void;
  /** The sheet's header, under the handle; it drags the sheet too. */
  title?: string;
  testID?: string;
  /**
   * Keep the sheet at its full height whatever its content (it still shrinks to fit above the keyboard). A sheet with
   * a search field at its top needs it: a sheet that shrank with few results would move its own search field around.
   */
  fullHeight?: boolean;
  /** The sheet's own look over the default (padding, gap, background). */
  sheetStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

type SheetContextValue = {
  close: (after?: () => void) => void;
  /** The drag that closes the sheet from its content; enabled while the content is scrolled to its top. */
  contentPan: MobileDismissPan;
  reportScrollTop: (atTop: boolean) => void;
};

const SheetContext = createContext<SheetContextValue | null>(null);

/** Inside a sheet: slide it out, report the close (`onClose`), then run `after` (e.g. start what was picked). */
export const useMobileSheetClose = (): ((after?: () => void) => void) => {
  const sheet = useContext(SheetContext);
  return sheet?.close ?? ((after) => after?.());
};

/**
 * The drag that dismisses a sheet or a screen shown as one (Parrot's Now playing): `offset` follows the finger down;
 * released past the close distance or on a flick it calls `dismiss` (which slides `offset` out), otherwise it springs
 * back. Returns a factory: one gesture per view it is attached to, `enabled` false hands every touch to the content.
 */
export const useMobileDismissPan = (offset: Animated.Value, dismiss: () => void): ((enabled: boolean) => MobileDismissPan) =>
  useCallback(
    (enabled: boolean) =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(enabled)
        // A drag down starts it; a drag up or sideways leaves the touch to the content (scroll, sliders, rows).
        .activeOffsetY(10)
        .failOffsetY(-10)
        .failOffsetX([-20, 20])
        .onUpdate((event) => offset.setValue(sheetDragOffset(event.translationY)))
        .onEnd((event) => {
          if (shouldCloseSheet(event.translationY, event.velocityY)) {
            dismiss();
            return;
          }
          Animated.spring(offset, { toValue: 0, damping: 22, stiffness: 260, mass: 0.35, useNativeDriver: true }).start();
        }),
    [offset, dismiss],
  );

/** Top edge of the on-screen keyboard in screen coordinates while `active`, or null while it is hidden. */
const useKeyboardTop = (active: boolean): number | null => {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const show = (event: KeyboardEvent) => setTop(event.endCoordinates.screenY);
    const hide = () => setTop(null);
    // iOS sends the "will" events as the keyboard starts to move; Android only the "did" ones.
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", show),
      Keyboard.addListener("keyboardDidShow", show),
      Keyboard.addListener("keyboardWillHide", hide),
      Keyboard.addListener("keyboardDidHide", hide),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [active]);
  return active ? top : null;
};

/**
 * The sheet always fits the space above the keyboard, so a search field at its top stays on screen and only its list
 * shrinks. That space is measured, not guessed per platform: the overlay's own height (Android resizes the modal above
 * the keyboard) minus whatever part of it the keyboard still covers (iOS does not resize it).
 */
export const MobileBottomSheet = memo(
  ({ visible, onClose, onClosed, title, testID, fullHeight, sheetStyle, children }: MobileBottomSheetProps) => {
    const theme = useMobileShellTheme();
    const { height: windowHeight } = useWindowDimensions();
    const travel = windowHeight;
    const [offset] = useState(() => new Animated.Value(travel));
    const [mounted, setMounted] = useState(visible);
    const closing = useRef(false);
    const callbacks = useRef({ onClose, onClosed });
    callbacks.current = { onClose, onClosed };

    const slideOut = useCallback(
      (done: () => void) => {
        closing.current = true;
        Animated.timing(offset, {
          toValue: travel,
          duration: SHEET_CLOSE_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(({ finished }) => {
          // Reopened while sliding out: the slide in took over.
          if (!finished) return;
          closing.current = false;
          setMounted(false);
          done();
          callbacks.current.onClosed?.();
        });
      },
      [offset, travel],
    );

    const close = useCallback(
      (after?: () => void) => {
        if (closing.current) return;
        slideOut(() => {
          callbacks.current.onClose();
          after?.();
        });
      },
      [slideOut],
    );

    const mountedRef = useRef(mounted);
    mountedRef.current = mounted;
    useEffect(() => {
      if (visible) setMounted(true);
      else if (mountedRef.current && !closing.current) slideOut(() => undefined);
    }, [visible, slideOut]);
    useEffect(() => {
      if (!mounted || !visible) return;
      offset.stopAnimation();
      closing.current = false;
      Animated.timing(offset, {
        toValue: 0,
        duration: SHEET_OPEN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, [mounted, visible, offset]);

    const makePan = useMobileDismissPan(offset, close);
    const handlePan = useMemo(() => makePan(true), [makePan]);
    const [contentAtTop, setContentAtTop] = useState(true);
    const contentAtTopRef = useRef(true);
    const reportScrollTop = useCallback((atTop: boolean) => {
      if (atTop === contentAtTopRef.current) return;
      contentAtTopRef.current = atTop;
      setContentAtTop(atTop);
    }, []);
    const contentPan = useMemo(() => makePan(contentAtTop), [makePan, contentAtTop]);
    const context = useMemo(() => ({ close, contentPan, reportScrollTop }), [close, contentPan, reportScrollTop]);
    const backdropOpacity = useMemo(() => offset.interpolate(sheetBackdropInterpolation(travel)), [offset, travel]);

    const [overlayHeight, setOverlayHeight] = useState<number | null>(null);
    const keyboardTop = useKeyboardTop(mounted);
    const area = overlayHeight ?? windowHeight;
    const keyboardOverlap = keyboardTop === null ? 0 : Math.min(area, Math.max(0, area - keyboardTop));
    const limit = (area - keyboardOverlap) * SHEET_SHARE;

    return (
      <Modal
        visible={mounted}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => close()}
      >
        {/* Android: a Modal is its own window, so gestures inside it need their own root. */}
        <GestureHandlerRootView style={styles.root}>
          {/* UX-CRASH-01: a crash inside the sheet closes it; the window guard says why. */}
          <MobileRenderBoundary name="modal:sheet" onDismiss={() => close()}>
            <View
              style={[styles.overlay, { paddingBottom: keyboardOverlap }]}
              onLayout={(event: LayoutChangeEvent) => setOverlayHeight(event.nativeEvent.layout.height)}
              testID={testID ? `${testID}-overlay` : undefined}
            >
              {/* The backdrop never moves: only its opacity follows the sheet. */}
              <Animated.View
                testID={testID ? `${testID}-backdrop` : undefined}
                style={[StyleSheet.absoluteFill, { backgroundColor: SHEET_BACKDROP_COLOR, opacity: backdropOpacity }]}
              >
                <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} accessible={false} />
              </Animated.View>
              <Animated.View
                testID={testID}
                accessibilityViewIsModal
                onAccessibilityEscape={() => close()}
                style={[
                  styles.sheet,
                  { backgroundColor: theme.colors.surfaceRaised },
                  fullHeight ? { height: limit } : { maxHeight: limit },
                  sheetStyle,
                  { transform: [{ translateY: offset }] },
                ]}
              >
                <GestureDetector gesture={handlePan}>
                  <View style={styles.dragZone} testID={testID ? `${testID}-handle` : undefined}>
                    <View style={styles.handle}>
                      <View style={styles.handleBar} />
                    </View>
                    {title ? (
                      <Text
                        accessibilityRole="header"
                        style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display }]}
                      >
                        {title}
                      </Text>
                    ) : null}
                  </View>
                </GestureDetector>
                <SheetContext.Provider value={context}>{children}</SheetContext.Provider>
              </Animated.View>
            </View>
          </MobileRenderBoundary>
        </GestureHandlerRootView>
      </Modal>
    );
  },
);
MobileBottomSheet.displayName = "MobileBottomSheet";

/**
 * A ScrollView inside a `MobileBottomSheet`: scrolled to its top, a downward drag moves the sheet (and past the close
 * distance closes it); anywhere else it scrolls. Outside a sheet it is a plain ScrollView.
 */
export const MobileSheetScrollView = forwardRef<ScrollViewInstance, ScrollViewProps>(({ style, onScroll, ...props }, ref) => {
  const sheet = useContext(SheetContext);
  const contentPan = sheet?.contentPan;
  // The list waits for the sheet's drag to fail: a drag up fails it at once, so scrolling stays immediate.
  const native = useMemo(
    () => (contentPan ? Gesture.Native().requireExternalGestureToFail(contentPan) : null),
    [contentPan],
  );
  const reportScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      sheet?.reportScrollTop(event.nativeEvent.contentOffset.y <= 1);
      onScroll?.(event);
    },
    [sheet, onScroll],
  );
  if (!sheet || !contentPan || !native) return <ScrollView ref={ref} style={style} onScroll={onScroll} {...props} />;
  return (
    <GestureDetector gesture={contentPan}>
      <View style={[styles.scrollFrame, style]} collapsable={false}>
        <GestureDetector gesture={native}>
          <ScrollView ref={ref} scrollEventThrottle={16} {...props} onScroll={reportScroll} />
        </GestureDetector>
      </View>
    </GestureDetector>
  );
});
MobileSheetScrollView.displayName = "MobileSheetScrollView";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  overlay: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    // The corners stay clear: nothing inside paints past the curve.
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.10)",
    gap: 10,
  },
  dragZone: { minHeight: SHEET_HANDLE_HEIGHT, paddingBottom: 4 },
  handle: { alignSelf: "center", width: "100%", height: 24, alignItems: "center", justifyContent: "center" },
  handleBar: { width: 38, height: 4, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.28)" },
  title: { fontSize: 18, fontWeight: "800" },
  scrollFrame: { flexShrink: 1 },
});
