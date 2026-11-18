import React from "react";
import { Pressable, StyleSheet, Text, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from "react-native";
import { crashAfterRetry, memoryReloadMarker, popupCrashNotice, renderErrorCopyFor, renderErrorWindowDetail } from "@space/shared/renderError";
import { reportCaughtError } from "@space/error-report/caught";

import { getCurrentLanguage } from "../i18n";
import { useMobileShellTheme } from "../theme";
import MobileAppBackdrop from "./mobile-app-backdrop";
import { MobileAuthBrand } from "./mobile-auth-brand";

/**
 * Render crash isolation on the phone and TV apps (UX-CRASH-01): an element that throws while rendering shows a notice
 * with one "Try again" button in its own place instead of React unmounting the whole app into a white (release) or red
 * (dev) screen. The words are the web guard's (`@space/shared/renderError`), in the app's current language.
 *
 * "Try again" (the only button) first retries: `onRetry` (the app clears or refetches the data the part used), then
 * the part is mounted anew under a fresh key. When the same guard throws again within a few seconds of that press, it
 * reloads by itself, with no second notice: the app's whole tree starts again from scratch through the window guard
 * (every provider and screen below it is mounted anew, so the stored session and settings are read again), the in-app
 * equivalent of the web guard's page reload. A marker in module memory (it outlives that in-app reload) makes a crash
 * after the reload show the notice again, and the next press only retries: never a reload loop (`crashAfterRetry`).
 *
 * - `section` (default): a screen (`screenLayout`) or a row: a small notice.
 * - `item`: one card or row of a long list (a `FlatList` cell: `{() => renderCell()}` as children, or `guardRenderItem`): a quiet "This
 *   item can't be shown." placeholder in its place, so the other items stay; no button (the same data would throw again).
 * - `onDismiss` set (a pop-up: a `<Modal>`'s content): the crash closes the pop-up through `onDismiss`, and the window
 *   guard shows "This window hit an error and was closed." with OK on the main window, since the modal is gone.
 * - `window`: the app's last line of defence, around its whole tree: a full-screen notice in the sign-in screen's look:
 *   the star sky, the app's floating mascot (`mascotSource`) and "Something went wrong. <App> needs to restart this
 *   screen." with the theme's `brandName`. It carries out the reload of every guard below it, and draws the
 *   closed-pop-up message over the app.
 */
export type MobileRenderBoundaryVariant = "section" | "window" | "item";

export type MobileRenderBoundaryProps = {
  /** Names the guarded element in the log line, e.g. "screen:Album" or "window". */
  name: string;
  variant?: MobileRenderBoundaryVariant;
  /** Changing it clears a caught error (a new route or item). */
  resetKey?: unknown;
  /**
   * Called on "Try again" before the part is mounted anew: drop or refetch the cached data it rendered from, so the
   * retry does not render the same broken data again. When it returns a promise, the part is mounted anew once it
   * settles, so the retry renders the fresh data.
   */
  onRetry?: () => void | Promise<unknown>;
  /** On the `window` variant: called when the app's tree is reloaded (a retry failed again), before it is mounted anew. */
  onReload?: () => void;
  /** The `window` variant's mascot, the one the sign-in screen floats. */
  mascotSource?: ImageSourcePropType;
  /** A pop-up's close: a crash inside calls it and posts the closed-pop-up message instead of showing the notice. */
  onDismiss?: () => void;
  /** The `item` placeholder's size and spacing, so it keeps the crashed card's place (e.g. a poster's width). */
  style?: StyleProp<ViewStyle>;
  /**
   * The guarded element. Pass a function when the element is built by a plain call in the parent's render (a list's
   * `renderItem`): the guard calls it below itself, so a throw while building it is caught here too.
   */
  children?: React.ReactNode | (() => React.ReactNode);
};

type State = { error: Error | null; resetKey: unknown; generation: number; retrying: boolean };

/** The in-app reload a failed retry made; module memory outlives it (the tree is mounted anew, the JS stays). */
const reloadMarker = memoryReloadMarker();

/** The mounted window guards: a section guard whose retry failed asks them to reload the app's tree. */
const windowReloaders = new Set<() => void>();

export class MobileRenderBoundary extends React.Component<MobileRenderBoundaryProps, State> {
  state: State = { error: null, resetKey: this.props.resetKey, generation: 0, retrying: false };
  /** When the part was last mounted anew by "Try again"; a crash soon after it means the retry could not work. */
  private retriedAt: number | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: MobileRenderBoundaryProps, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { error: null, resetKey: props.resetKey, retrying: false };
  }

  componentDidMount(): void {
    if (this.props.variant === "window") windowReloaders.add(this.reloadTree);
  }

  componentWillUnmount(): void {
    windowReloaders.delete(this.reloadTree);
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[render-boundary] ${this.props.name} crashed: ${error.message}`, info.componentStack);
    // REL-LOG-06: a caught error never reaches the SDK's global handlers; send it while reporting is on.
    reportCaughtError(error, this.props.onDismiss ? "popup" : (this.props.variant ?? "section"));
    if (this.props.onDismiss) {
      console.info(`[render-boundary] ${this.props.name} closed`);
      popupCrashNotice.post(this.props.name);
      this.props.onDismiss();
      return;
    }
    const now = Date.now();
    const retriedAt = this.retriedAt;
    this.retriedAt = null;
    const next = crashAfterRetry({ retriedAt, now, marker: reloadMarker });
    console.info(
      `[render-boundary] ${this.props.name} crash after try again: ${next}`,
      retriedAt === null ? "(no try again pending)" : `(${now - retriedAt} ms after the press)`
    );
    if (next === "reload") this.reload();
  }

  /** "Try again": clear the app's data for this part (waiting for it when `onRetry` is async), then mount it anew. */
  retry = (): void => {
    if (this.state.retrying) return;
    console.info(`[render-boundary] ${this.props.name} try again`);
    let pending: unknown;
    try {
      pending = this.props.onRetry?.();
    } catch (error) {
      console.error(`[render-boundary] ${this.props.name} onRetry failed`, error);
    }
    if (!(pending instanceof Promise)) {
      this.remount();
      return;
    }
    this.setState({ retrying: true });
    pending
      .catch((error: unknown) => console.error(`[render-boundary] ${this.props.name} onRetry failed`, error))
      // No "still mounted?" flag: StrictMode unmounts and mounts the same instance again, which left such a flag set
      // for good; React ignores a setState after a real unmount.
      .then(() => {
        console.info(`[render-boundary] ${this.props.name} data refreshed: mounting anew`);
        this.remount();
      });
  };

  /** Mounts the part anew under a fresh key; its component state is thrown away. */
  private remount = (): void => {
    this.retriedAt = Date.now();
    this.setState((state) => ({ error: null, retrying: false, generation: state.generation + 1 }));
  };

  /** The retry failed again right away: reload the app's tree, without asking. */
  private reload = (): void => {
    console.info(`[render-boundary] ${this.props.name} still failing after try again: reloading the app`);
    if (this.props.variant === "window") {
      this.reloadTree();
      return;
    }
    // The latest mounted window guard: the app has one; a stale one (a test that never unmounted) must not win.
    const windowGuard = [...windowReloaders].at(-1);
    if (windowGuard) windowGuard();
    // No window guard mounted (a test, a guard used alone): mounting this part anew is the most it can do.
    else this.setState((state) => ({ error: null, generation: state.generation + 1 }));
  };

  /** The window guard's reload: the app's whole tree below it is thrown away and mounted anew. */
  private reloadTree = (): void => {
    console.info(`[render-boundary] ${this.props.name} reload`);
    this.props.onReload?.();
    this.setState((state) => ({ error: null, generation: state.generation + 1 }));
  };

  render(): React.ReactNode {
    const window = this.props.variant === "window";
    if (!this.state.error) {
      const { children } = this.props;
      const guarded = typeof children === "function" ? <RenderGuarded render={children} /> : children;
      // A new key on "Try again" or a reload throws away every component state below and mounts it again.
      const content = <React.Fragment key={this.state.generation}>{guarded}</React.Fragment>;
      if (!window) return content;
      return (
        <>
          {content}
          <MobilePopupCrashNotice />
        </>
      );
    }
    // A pop-up that crashed is being closed by its owner; draw nothing meanwhile.
    if (this.props.onDismiss) return null;
    if (this.props.variant === "item") return <MobileItemFallback name={this.props.name} style={this.props.style} />;
    return (
      <MobileRenderFallback
        name={this.props.name}
        onRetry={this.retry}
        busy={this.state.retrying}
        window={window}
        mascotSource={window ? this.props.mascotSource : undefined}
      />
    );
  }
}

/** Calls a render function as its own component, below the guard (a guard never catches its own render). */
const RenderGuarded = ({ render }: { render: () => React.ReactNode }) => <>{render()}</>;

/**
 * Wraps a `FlatList` `renderItem` so each cell sits in its own `item` guard (UX-CRASH-01): one card or row that throws
 * shows the placeholder and the rest of the list stays. The guard is named `<name>:<item.id>` (the index when the item
 * has no string id); `style` sizes the placeholder like the cell (a tile's width).
 */
export const guardRenderItem =
  <Item,>(name: string, renderItem: (info: { item: Item; index: number }) => React.ReactNode, style?: StyleProp<ViewStyle>) =>
  (info: { item: Item; index: number }): React.ReactElement => {
    const id = (info.item as { id?: unknown } | null)?.id;
    return (
      <MobileRenderBoundary name={`${name}:${typeof id === "string" ? id : info.index}`} variant="item" style={style}>
        {() => renderItem(info)}
      </MobileRenderBoundary>
    );
  };

/** The placeholder of one list item that crashed. */
const MobileItemFallback = ({ name, style }: { name: string; style?: StyleProp<ViewStyle> }) => {
  const theme = useMobileShellTheme();
  const copy = renderErrorCopyFor(getCurrentLanguage());
  return (
    <View testID={`render-boundary-item:${name}`} style={[styles.item, { borderColor: theme.colors.border }, style]}>
      <Text style={[styles.itemText, { color: theme.colors.textMuted }]}>{copy.itemFailed}</Text>
    </View>
  );
};

/**
 * The notice of a caught crash with its one button, "Try again"; with `window` it is the full-screen window notice:
 * the star sky, the mascot and the app's name above the button.
 */
export const MobileRenderFallback = ({
  name,
  onRetry,
  busy = false,
  window = false,
  mascotSource,
}: {
  name: string;
  onRetry: () => void;
  /** The app is refreshing the data after a press: the button waits. */
  busy?: boolean;
  window?: boolean;
  mascotSource?: ImageSourcePropType;
}) => {
  const theme = useMobileShellTheme();
  const copy = renderErrorCopyFor(getCurrentLanguage());
  const retry = (
    <Pressable
      accessibilityRole="button"
      testID={`render-boundary:${name}:retry`}
      onPress={onRetry}
      disabled={busy}
      accessibilityState={{ disabled: busy, busy }}
      style={[styles.button, { backgroundColor: theme.accentHex }]}
    >
      <Text style={[styles.buttonLabel, { color: theme.accentTextHex }]}>{copy.retry}</Text>
    </Pressable>
  );
  if (!window) {
    return (
      <View
        accessibilityRole="alert"
        testID={`render-boundary:${name}`}
        style={[styles.box, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
      >
        <Text style={[styles.message, { color: theme.colors.text }]}>{copy.message}</Text>
        <Text style={[styles.detail, { color: theme.colors.textMuted }]}>{copy.detail}</Text>
        <View style={styles.actions}>{retry}</View>
      </View>
    );
  }
  return (
    <View accessibilityRole="alert" testID={`render-boundary:${name}`} style={[styles.window, { backgroundColor: theme.colors.bg }]}>
      <MobileAppBackdrop />
      {mascotSource ? <MobileAuthBrand iconSource={mascotSource} /> : null}
      <Text style={[styles.message, styles.centered, { color: theme.colors.text }]}>{copy.message}</Text>
      <Text style={[styles.detail, styles.centered, { color: theme.colors.textMuted }]}>
        {renderErrorWindowDetail(copy, theme.brandName)}
      </Text>
      <View style={[styles.actions, styles.actionsCentered]}>{retry}</View>
    </View>
  );
};

/** "This window hit an error and was closed." with OK, over the app, after a pop-up guard closed its pop-up. */
const MobilePopupCrashNotice = () => {
  const closed = React.useSyncExternalStore(popupCrashNotice.subscribe, popupCrashNotice.current, popupCrashNotice.current);
  const theme = useMobileShellTheme();
  if (!closed) return null;
  const copy = renderErrorCopyFor(getCurrentLanguage());
  return (
    <View
      accessibilityRole="alert"
      testID={`render-boundary-popup-closed:${closed}`}
      style={[styles.banner, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
    >
      <Text style={[styles.detail, styles.bannerText, { color: theme.colors.text }]}>{copy.popupClosed}</Text>
      <Pressable
        accessibilityRole="button"
        testID="render-boundary-popup-closed:dismiss"
        onPress={popupCrashNotice.dismiss}
        style={[styles.button, { backgroundColor: theme.accentHex }]}
      >
        <Text style={[styles.buttonLabel, { color: theme.accentTextHex }]}>{copy.dismiss}</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  box: { margin: 16, padding: 16, borderRadius: 12, borderWidth: 1, gap: 8 },
  window: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  message: { fontSize: 16, fontWeight: "700" },
  detail: { fontSize: 14 },
  centered: { textAlign: "center", maxWidth: 420 },
  actions: { flexDirection: "row", gap: 12, marginTop: 4 },
  actionsCentered: { justifyContent: "center" },
  button: { alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  buttonLabel: { fontSize: 14, fontWeight: "700" },
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerText: { flex: 1 },
  item: {
    flex: 1,
    minHeight: 48,
    margin: 4,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: { fontSize: 12, textAlign: "center" },
});
