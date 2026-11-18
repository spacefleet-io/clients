import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = "src/components/desktop-notification-tray-content.tsx";

// On assertion failure, dump enough source context to diagnose offline without
// re-opening the file by hand (per the "tests log generously" rule). Wrapped in
// try/catch so a dump failure can't mask the original assertion error.
const dumpTrayContentSnapshot = (label: string, source: string, needles: string[]) => {
  try {
    console.error(`=== [notification-tray-content:${label}] source snapshot ===`);
    console.error(`source path=${SOURCE_PATH} length=${source.length} chars`);
    for (const needle of needles) {
      const present = source.includes(needle);
      console.error(`  needle ${JSON.stringify(needle)} present=${present}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert a source string is present, dumping context on miss before the throw.
const expectContains = (label: string, source: string, needle: string) => {
  if (!source.includes(needle)) {
    dumpTrayContentSnapshot(label, source, [needle]);
  }
  expect(source).toContain(needle);
};

describe("desktop notification tray content", () => {
  console.info(`[notification-tray-content:setup] reading source ${SOURCE_PATH}`);
  const source = readFileSync(
    resolve(process.cwd(), SOURCE_PATH),
    "utf8"
  );
  console.info(`[notification-tray-content:setup] source loaded, length=${source.length} chars`);

  it("renders filter pills for all notification levels", () => {
    expectContains("filter-pills", source, 'const FILTERS = ["all", "error", "warning", "info", "success"]');
  });

  it("uses color-coded left borders per notification level", () => {
    expectContains("color-borders", source, '"border-l-destructive"');
    expectContains("color-borders", source, '"border-l-yellow-500"');
    expectContains("color-borders", source, '"border-l-green-500"');
    expectContains("color-borders", source, '"border-l-primary"');
  });

  it("supports expand/collapse with chevron icons", () => {
    expectContains("expand-collapse", source, "ChevronDown");
    expectContains("expand-collapse", source, "ChevronRight");
    expectContains("expand-collapse", source, "expandedId");
  });

  it("provides clear-all and per-item dismiss actions", () => {
    expectContains("dismiss-actions", source, "onClearAll");
    expectContains("dismiss-actions", source, "onRemove(id)");
    expectContains("dismiss-actions", source, "Trash2");
  });

  it("accepts a renderActions slot for custom per-notification actions", () => {
    expectContains("render-actions-slot", source, "renderActions?.(n)");
  });

  it("accepts labels prop for i18n instead of a translation function", () => {
    expectContains("i18n-labels", source, "NotificationTrayLabels");
    expectContains("i18n-labels", source, "filterLabel(level, labels)");
  });

  it("[@bugfix][@regression-proof] defers the actual remove call through the shared dismiss scheduler", () => {
    console.info(`[notification-tray-content:scheduler-defer] asserting deferred-remove wiring`);
    // Pre-fix: clicking the X called onRemove(n.id) directly, so the row
    // vanished instantly. The shared `useStaggeredDismiss` hook now wraps the
    // call: the row gets marked as "removing" (animation kicks in), and the
    // real `onRemove` runs after the animation has completed.
    expectContains("scheduler-defer", source, "useStaggeredDismiss");
    expectContains("scheduler-defer", source, "scheduleDismiss(id, () => onRemove(id))");
    expectContains("scheduler-defer", source, "handleRemove(n.id)");
  });

  it("[@bugfix][@regression-proof] uses the shared AnimatedDismissRow so siblings glide up smoothly", () => {
    console.info(`[notification-tray-content:animated-row] asserting AnimatedDismissRow usage`);
    // Pre-fix: rows faded + slid for 220ms while still occupying their full
    // height, then neighbours snapped up at unmount. The shared
    // `AnimatedDismissRow` wrapper owns the grid-template-rows collapse +
    // `!mt-0` margin override so the gap closes in lockstep with the slide.
    expectContains("animated-row", source, "AnimatedDismissRow");
    const removingProp = /<AnimatedDismissRow[\s\S]*?removing=\{isRemoving\}/;
    if (!removingProp.test(source)) {
      dumpTrayContentSnapshot("animated-row", source, ["<AnimatedDismissRow ... removing={isRemoving}"]);
    }
    expect(source).toMatch(removingProp);
  });

  it("[@bugfix][@regression-proof] keeps the filter row visible while items scroll", () => {
    console.info(`[notification-tray-content:sticky-filter] asserting sticky filter row`);
    // The filter pills must stay reachable as the user scrolls a long list,
    // otherwise switching from "All" to "Error" requires scrolling back to top.
    const stickyPattern = /sticky[\s\S]*top-0[\s\S]*bg-\[#0d1117\]/;
    if (!stickyPattern.test(source)) {
      dumpTrayContentSnapshot("sticky-filter", source, ["sticky ... top-0 ... bg-[#0d1117]"]);
    }
    expect(source).toMatch(stickyPattern);
  });
});
