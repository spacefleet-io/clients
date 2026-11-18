/**
 * @test-id MOBILE-SHELL-OFFLINE-INDICATOR-001
 * @level unit
 * @req UX-NOTICE-02[badger-mobile]
 * @why Chris 2026-11-13 (design feedback): offline is a normal state of the app, so the phone shows it with a small
 *   lasting sign on the tab bar, never a banner. The old `MobileOfflineBanner` was a wide red box above every page
 *   with a technical detail line under it. This pins the sign: a short word ("Offline", or "Not synced" when the
 *   connection is fine but the media library could not sync), a spoken label that says the saved content is shown,
 *   the number of changes waiting, tap to retry, and no technical detail. Also the pluralization of the waiting count.
 */
import React from "react";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../src/i18n";
import { formatPendingOpsLabel, MobileOfflineIndicator } from "../src/components/mobile-offline-indicator";

// Stub native deps so we can invoke the component as a pure function.
// React.createElement passes our stub *components* through as element types,
// so we don't actually need to do anything inside the stubs — React's element
// representation already carries `type` + `props` for us to inspect.
// `vi.hoisted` so the stub identities exist when vi.mock is hoisted above imports.
const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const PressableStub: Stub = (props) => props;
  PressableStub.displayName = "PressableStub";
  const TextStub: Stub = (props) => props;
  TextStub.displayName = "TextStub";
  const ViewStub: Stub = (props) => props;
  ViewStub.displayName = "ViewStub";
  return { PressableStub, TextStub, ViewStub };
});

vi.mock("react-native", () => {
  return {
    Pressable: stubs.PressableStub,
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
    },
    Text: stubs.TextStub,
    View: stubs.ViewStub,
  };
});
vi.mock("lucide-react-native", () => ({
  CloudOff: () => null,
  RefreshCw: () => null,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: {
      danger: "#ff7f7f",
      textMuted: "#94a3bb",
      textDim: "#64768f",
    },
  }),
}));
// The component calls useTranslation() as a hook; invoked as a pure function it has no React renderer, so
// bind it to the real i18next instance (initialised with the bundled English resources below). The dynamic
// import is required: vi.mock factories are hoisted above the static imports.
vi.mock("react-i18next", async () => {
  const { default: instance } = await import("i18next");
  return {
    initReactI18next: { type: "3rdParty", init: () => undefined },
    useTranslation: () => ({ t: instance.t.bind(instance) }),
  };
});

const t = i18next.t.bind(i18next);

beforeAll(async () => {
  await initI18n("en");
});

// Walk a stub element tree collecting every string child node. Shared by the
// wiring tests and the dump helper so the snapshot shows exactly what the tree
// renders. Pure / side-effect-free.
const collectTextNodes = (node: any, out: string[]): string[] => {
  if (!node) return out;
  const children = node.props?.children;
  if (typeof children === "string") {
    out.push(children);
  } else if (Array.isArray(children)) {
    children.forEach((child) => collectTextNodes(child, out));
  } else if (children && typeof children === "object") {
    collectTextNodes(children, out);
  }
  return out;
};

// On assertion failure, dump enough state to diagnose the sign without a
// manual repro (per memory feedback: tests must self-diagnose). Body wrapped in
// try/catch so a dump failure can't mask the real assertion failure.
const dumpOfflineIndicatorSnapshot = (
  label: string,
  ctx: { tree?: any; props?: unknown; observed?: unknown; expected?: unknown },
) => {
  try {
    console.error(`=== [mobile-offline-indicator:${label}] snapshot ===`);
    if (ctx.props !== undefined) {
      console.error(`props: ${JSON.stringify(ctx.props)}`);
    }
    if (ctx.tree) {
      const rootType =
        (ctx.tree.type && (ctx.tree.type.displayName ?? ctx.tree.type.name)) ||
        String(ctx.tree.type);
      console.error(`tree.type=${rootType}`);
      console.error(
        `tree.props.accessibilityLabel=${JSON.stringify(ctx.tree.props?.accessibilityLabel)}`,
      );
      console.error(`tree.props.onPress isFn=${typeof ctx.tree.props?.onPress === "function"}`);
      const allText = collectTextNodes(ctx.tree, []);
      console.error(`collected text nodes (${allText.length}):\n${JSON.stringify(allText, null, 2)}`);
    }
    if (ctx.expected !== undefined || ctx.observed !== undefined) {
      console.error(
        `expected=${JSON.stringify(ctx.expected)} observed=${JSON.stringify(ctx.observed)}`,
      );
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("formatPendingOpsLabel — pluralization", () => {
  it("zero changes shows 'No changes queued'", () => {
    const observed = formatPendingOpsLabel(0, t);
    console.info(`[mobile-offline-indicator:pluralize-zero] input=0 observed=${JSON.stringify(observed)}`);
    if (observed !== "No changes queued") {
      dumpOfflineIndicatorSnapshot("pluralize-zero", { observed, expected: "No changes queued" });
    }
    expect(observed).toBe("No changes queued");
  });

  it("negative counts collapse to zero", () => {
    const observed = formatPendingOpsLabel(-3, t);
    console.info(`[mobile-offline-indicator:pluralize-negative] input=-3 observed=${JSON.stringify(observed)}`);
    if (observed !== "No changes queued") {
      dumpOfflineIndicatorSnapshot("pluralize-negative", { observed, expected: "No changes queued" });
    }
    expect(observed).toBe("No changes queued");
  });

  it("singular form for one", () => {
    const observed = formatPendingOpsLabel(1, t);
    console.info(`[mobile-offline-indicator:pluralize-one] input=1 observed=${JSON.stringify(observed)}`);
    if (observed !== "1 change will sync when reconnected") {
      dumpOfflineIndicatorSnapshot("pluralize-one", {
        observed,
        expected: "1 change will sync when reconnected",
      });
    }
    expect(observed).toBe("1 change will sync when reconnected");
  });

  it("plural form for many", () => {
    const observed = formatPendingOpsLabel(7, t);
    console.info(`[mobile-offline-indicator:pluralize-many] input=7 observed=${JSON.stringify(observed)}`);
    if (observed !== "7 changes will sync when reconnected") {
      dumpOfflineIndicatorSnapshot("pluralize-many", {
        observed,
        expected: "7 changes will sync when reconnected",
      });
    }
    expect(observed).toBe("7 changes will sync when reconnected");
  });

  it("plural form for two (boundary)", () => {
    const observed = formatPendingOpsLabel(2, t);
    console.info(`[mobile-offline-indicator:pluralize-two] input=2 observed=${JSON.stringify(observed)}`);
    if (observed !== "2 changes will sync when reconnected") {
      dumpOfflineIndicatorSnapshot("pluralize-two", {
        observed,
        expected: "2 changes will sync when reconnected",
      });
    }
    expect(observed).toBe("2 changes will sync when reconnected");
  });
});

describe("MobileOfflineIndicator — the small offline sign", () => {
  const build = (props: Record<string, unknown>) => {
    const tree = (MobileOfflineIndicator as unknown as (p: unknown) => any)(props);
    const text = collectTextNodes(tree, []);
    console.info(
      `[mobile-offline-indicator:build] props=${JSON.stringify(props)} label=${JSON.stringify(tree?.props?.accessibilityLabel)} text=${JSON.stringify(text)}`,
    );
    return { tree, text };
  };

  it("is one tappable pill that retries: the word Offline, a spoken label naming the saved content", () => {
    const onRetry = vi.fn();
    const props = { pendingOps: 0, onRetry };
    const { tree, text } = build(props);
    try {
      expect(tree.type).toBe(stubs.PressableStub);
      expect(tree.props.testID).toBe("mobile-offline-indicator");
      expect(tree.props.accessibilityRole).toBe("button");
      expect(tree.props.accessibilityLabel).toBe("Offline — saved content. Tap to retry.");
      expect(text).toEqual(["Offline"]);
      tree.props.onPress();
      expect(onRetry).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpOfflineIndicatorSnapshot("network", { tree, props, observed: text });
      throw err;
    }
  });

  it("when the connection is fine but the sync failed, it never says Offline", () => {
    const props = { pendingOps: 0, onRetry: () => undefined, variant: "sync_error" };
    const { tree, text } = build(props);
    try {
      expect(text).toEqual(["Not synced"]);
      expect(tree.props.accessibilityLabel).toBe("Media library not synced — saved content. Tap to retry.");
      expect(JSON.stringify(text)).not.toMatch(/offline/i);
    } catch (err) {
      dumpOfflineIndicatorSnapshot("sync-error", { tree, props, observed: text });
      throw err;
    }
  });

  it("shows the number of changes waiting as a small count, and says it in full to screen readers", () => {
    const props = { pendingOps: 3, onRetry: () => undefined };
    const { tree, text } = build(props);
    try {
      expect(text).toEqual(["Offline", "3"]);
      expect(tree.props.accessibilityLabel).toBe(
        "Offline — saved content. 3 changes will sync when reconnected. Tap to retry.",
      );
    } catch (err) {
      dumpOfflineIndicatorSnapshot("pending", { tree, props, observed: text });
      throw err;
    }
  });

  it("is compact: one line, small type, no detail text, no fixed width", () => {
    const props = { pendingOps: 0, onRetry: () => undefined, detail: "Could not reach the API at http://10.0.2.2:3000" };
    const { tree, text } = build(props);
    const rawStyle = typeof tree.props.style === "function" ? tree.props.style({ pressed: false }) : tree.props.style;
    const style = Object.assign({}, ...[rawStyle].flat(3).filter((s: unknown) => s && typeof s === "object"));
    console.info(`[mobile-offline-indicator:compact] style=${JSON.stringify(style)}`);
    try {
      expect(JSON.stringify(text)).not.toContain("http");
      expect(style.height).toBeLessThanOrEqual(24);
      expect(style.width).toBeUndefined();
      expect(style.flexDirection).toBe("row");
    } catch (err) {
      dumpOfflineIndicatorSnapshot("compact", { tree, props, observed: style });
      throw err;
    }
  });
});
