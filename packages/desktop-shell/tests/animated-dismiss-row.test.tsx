import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level pins for the shared dismiss-animation primitives. The actual
// runtime behaviour is exercised through the consumers (notification tray,
// jobs sidebar) — these assertions ensure the shared file keeps the contract
// that the consumers rely on.

const SOURCE_PATH = "src/components/animated-dismiss-row.tsx";

// Dump source context on assertion failure (per "tests log generously"). Wrapped
// in try/catch so a dump failure can't mask the original assertion error.
const dumpDismissRowSnapshot = (label: string, source: string, needles: string[]) => {
  try {
    console.error(`=== [animated-dismiss-row:${label}] source snapshot ===`);
    console.error(`source path=${SOURCE_PATH} length=${source.length} chars`);
    for (const needle of needles) {
      console.error(`  needle ${JSON.stringify(needle)} present=${source.includes(needle)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const expectContains = (label: string, source: string, needle: string) => {
  if (!source.includes(needle)) {
    dumpDismissRowSnapshot(label, source, [needle]);
  }
  expect(source).toContain(needle);
};

describe("animated-dismiss-row shared helper", () => {
  console.info(`[animated-dismiss-row:setup] reading source ${SOURCE_PATH}`);
  const source = readFileSync(
    resolve(process.cwd(), SOURCE_PATH),
    "utf8"
  );
  console.info(`[animated-dismiss-row:setup] source loaded, length=${source.length} chars`);

  it("[@bugfix][@regression-proof] exposes a single source of truth for the animation duration", () => {
    console.info(`[animated-dismiss-row:duration-const] asserting DISMISS_ANIMATION_MS constant`);
    expectContains("duration-const", source, "export const DISMISS_ANIMATION_MS = 220");
  });

  it("[@bugfix][@regression-proof] collapses height + margin so siblings shift up smoothly", () => {
    console.info(`[animated-dismiss-row:collapse-grid] asserting grid-rows collapse + slide cues`);
    // Pre-fix (in each call site, before this helper existed): a leaving row
    // faded + slid for 220ms while still occupying its full height, then
    // neighbouring rows snapped up at unmount. The grid-template-rows
    // 1fr → 0fr transition animates the height collapse, and `!mt-0` defeats
    // the space-y margin contributed by the parent list container.
    expectContains("collapse-grid", source, "grid-rows-[1fr]");
    expectContains("collapse-grid", source, "grid-rows-[0fr]");
    expectContains("collapse-grid", source, "!mt-0");
    // The inner card stays clipped during the slide so it does not visually
    // overlap the next row while its track collapses.
    expectContains("collapse-grid", source, '"overflow-hidden"');
    // Slide + scale cue lives on the inner card (not the outer grid track)
    // so the height collapse and the lateral slide can run in parallel.
    const slidePattern = /translate-x-\d/;
    if (!slidePattern.test(source)) {
      dumpDismissRowSnapshot("collapse-grid", source, ["translate-x-<digit>"]);
    }
    expect(source).toMatch(slidePattern);
    expectContains("collapse-grid", source, "scale-95");
    expectContains("collapse-grid", source, "opacity-0");
    expectContains("collapse-grid", source, "transition-all duration-200");
    expectContains("collapse-grid", source, "transition-transform duration-200");
  });

  it("[@bugfix][@regression-proof] schedules the real remove action after the animation completes", () => {
    console.info(`[animated-dismiss-row:schedule-action] asserting useStaggeredDismiss timeout wiring`);
    // Pre-fix: the X-button handler ran the data-mutating action immediately,
    // so the row unmounted before the CSS transition could run. The hook now
    // flips `dismissing` first (animation starts), then runs `action` from a
    // window.setTimeout once the transition has finished.
    expectContains("schedule-action", source, "export function useStaggeredDismiss");
    expectContains("schedule-action", source, "scheduleDismiss");
    expectContains("schedule-action", source, "window.setTimeout");
    expectContains("schedule-action", source, "DISMISS_ANIMATION_MS");
    const setDismissingPattern = /setDismissing\s*\(/;
    if (!setDismissingPattern.test(source)) {
      dumpDismissRowSnapshot("schedule-action", source, ["setDismissing("]);
    }
    expect(source).toMatch(setDismissingPattern);
  });

  it("[@bugfix][@regression-proof] keeps the id pinned in dismissing so async actions don't pop the row back", () => {
    console.info(`[animated-dismiss-row:pin-id] asserting timeout body runs action but not setDismissing`);
    // For async remove actions (e.g. cancelJob over IPC) the underlying data
    // doesn't update synchronously. Clearing `id` from `dismissing` at the
    // end of the timeout would make the row re-render with `removing=false`
    // while the data still includes it, reversing the grid-rows transition
    // and visibly popping the row back into view before the snapshot drops
    // it. The hook intentionally leaves the id in the set; the consumer's
    // data flow is responsible for actually unmounting the row.
    const timeoutBlock = source.match(/window\.setTimeout\([\s\S]*?\}\,\s*DISMISS_ANIMATION_MS\)/);
    if (timeoutBlock === null) {
      dumpDismissRowSnapshot("pin-id", source, ["window.setTimeout(... }, DISMISS_ANIMATION_MS)"]);
    } else {
      console.info(
        `[animated-dismiss-row:pin-id] timeout body matched, length=${timeoutBlock[0].length} containsSetDismissing=${/setDismissing/.test(timeoutBlock[0])}`,
      );
    }
    expect(timeoutBlock).not.toBeNull();
    // Inside the timeout body, only the action runs — no setDismissing call.
    if (timeoutBlock && /setDismissing/.test(timeoutBlock[0])) {
      console.error(`=== [animated-dismiss-row:pin-id] timeout body unexpectedly calls setDismissing ===`);
      console.error(`timeout body:\n${timeoutBlock[0]}`);
    }
    expect(timeoutBlock?.[0]).not.toMatch(/setDismissing/);
  });
});
