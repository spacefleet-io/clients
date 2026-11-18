import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level regression pin. Live-run tests (top-nav-jobs-sidebar.test.tsx)
// mock the dismiss scheduler to keep them fast and deterministic — that means
// they cannot guard the *wiring* between the click handlers and the shared
// `useStaggeredDismiss` hook. This file asserts the wiring exists in source.

describe("TopNavJobsSidebarContent dismiss animation wiring", () => {
  const sourcePath = resolve(
    process.cwd(),
    "src/renderer/src/components/TopNavJobsSidebarContent.tsx"
  );
  console.info(`[top-nav-jobs-sidebar-dismiss-animation:setup] reading source ${sourcePath}`);
  const source = readFileSync(sourcePath, "utf8");
  console.info(
    `[top-nav-jobs-sidebar-dismiss-animation:setup] source loaded length=${source.length}`
  );

  // On a wiring miss, dump which specific token/pattern was absent so the
  // failing call-site is obvious without re-grepping the component.
  const dumpDismissWiringSnapshot = (
    label: string,
    checks: { name: string; ok: boolean; detail?: string }[],
  ) => {
    try {
      console.error(`=== [top-nav-jobs-sidebar-dismiss-animation:${label}] snapshot ===`);
      console.error(`sourcePath=${sourcePath} sourceLength=${source.length}`);
      for (const c of checks) {
        console.error(`check "${c.name}" ok=${c.ok}${c.detail ? ` detail=${c.detail}` : ""}`);
      }
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  it("[@bugfix][@regression-proof] imports the shared dismiss helpers from desktop-shell", () => {
    // Per the "Prefer reusing shared packages over app-specific duplication" convention
    // — the dismiss animation lives in @space/desktop-shell so every desktop app
    // can share it.
    const importLine = /import \{[^}]*\bDesktopJobGroupCard\b[^}]*\buseStaggeredDismiss\b[^}]*\} from "@space\/desktop-shell\/components"/;
    if (!importLine.test(source)) {
      dumpDismissWiringSnapshot("import", [
        { name: "shared-import-line", ok: false, detail: String(importLine) },
      ]);
    }
    expect(source).toMatch(importLine);
  });

  it("[@bugfix][@regression-proof] routes onCancel, onDismiss, onBulkCancel through scheduleDismiss", () => {
    // Pre-fix: clicking a trash button called cancelJob / dismissJob /
    // cancelByGroup directly, so the row vanished instantly. Each path now
    // schedules the action through the shared hook so the row gets a 220ms
    // collapse-slide-fade animation first.
    const onCancelRe = /onCancel=\{\(id\) => \{\s*scheduleDismiss\(id, \(\) => \{\s*void cancelJob\(id\);/;
    const onDismissRe = /onDismiss=\{\(id\) => \{\s*scheduleDismiss\(id, \(\) => \{\s*void dismissJob\(id\);/;
    const onBulkRe = /onBulkCancel=\{\(id\) => \{\s*scheduleDismiss\(id, \(\) => \{\s*void cancelByGroup\(id, "group-bulk-action"\);/;
    const checks = [
      { name: "onCancel->scheduleDismiss", ok: onCancelRe.test(source) },
      { name: "onDismiss->scheduleDismiss", ok: onDismissRe.test(source) },
      { name: "onBulkCancel->scheduleDismiss", ok: onBulkRe.test(source) },
    ];
    if (checks.some((c) => !c.ok)) dumpDismissWiringSnapshot("schedule-dismiss-routing", checks);
    expect(source).toMatch(onCancelRe);
    expect(source).toMatch(onDismissRe);
    expect(source).toMatch(onBulkRe);
  });

  // @req UX-JOBS-02[badger-desktop]
  it("[@bugfix][@regression-proof] wraps each removable row in the shared animated job cards", () => {
    // Three call sites: the group card (animates the whole card when
    // bulk-dismissed), SidebarJobRow (active job rows), CompletedJobRow
    // (terminal job rows). Each passes its own dismissing.has(id) gate as
    // `removing`, which the shared cards hand to <AnimatedDismissRow>
    // (UX-JOBS-02: the same cards in Badger and Parrot).
    const cardSource = readFileSync(
      resolve(process.cwd(), "../../../packages/desktop-shell/src/components/desktop-job-card.tsx"),
      "utf8",
    );
    const removingCount = (source.match(/removing=\{isRemoving\}/g) ?? []).length;
    const checks = [
      { name: "removing={isRemoving}>=3", ok: removingCount >= 3, detail: `count=${removingCount}` },
      { name: "card animates", ok: cardSource.includes("<AnimatedDismissRow removing={removing}") },
      { name: "dismissing.has(group.id)", ok: source.includes("dismissing.has(group.id)") },
      { name: "dismissing.has(job.id)", ok: source.includes("dismissing.has(job.id)") },
    ];
    if (checks.some((c) => !c.ok)) dumpDismissWiringSnapshot("animated-row-wrapping", checks);
    expect(removingCount).toBeGreaterThanOrEqual(3);
    expect(cardSource).toContain("<AnimatedDismissRow removing={removing}");
    // dismissing.has(group.id|job.id) is what flips the wrapper into the
    // collapsing state.
    expect(source).toContain("dismissing.has(group.id)");
    expect(source).toContain("dismissing.has(job.id)");
  });
});
