import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = "src/components/desktop-notification-tray.tsx";

// Dump source context on assertion failure (per "tests log generously"). Wrapped
// in try/catch so a dump failure can't mask the original assertion error.
const dumpTraySnapshot = (label: string, source: string, needles: string[]) => {
  try {
    console.error(`=== [notification-tray:${label}] source snapshot ===`);
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
    dumpTraySnapshot(label, source, [needle]);
  }
  expect(source).toContain(needle);
};

describe("desktop notification tray", () => {
  console.info(`[notification-tray:setup] reading source ${SOURCE_PATH}`);
  const source = readFileSync(
    resolve(process.cwd(), SOURCE_PATH),
    "utf8"
  );
  console.info(`[notification-tray:setup] source loaded, length=${source.length} chars`);

  it("[@bugfix][@regression-proof] keeps the shared tray shell contract centralized", () => {
    console.info(`[notification-tray:shell-contract] asserting centralized tray shell classes`);
    // Width + dark surface + close-button affordance live in the shell, not consumers.
    expectContains("shell-contract", source, "w-[340px]");
    expectContains("shell-contract", source, "bg-[#0d1117]");
    expectContains("shell-contract", source, "text-white");
    expectContains("shell-contract", source, "emptyMessage");
    expectContains("shell-contract", source, "SheetContent");
  });

  it("[@bugfix][@regression-proof] makes the body scrollable when content exceeds viewport height", () => {
    console.info(`[notification-tray:scrollable-body] asserting flex-col + overflow scroll wiring`);
    // Pre-fix bug: with 49+ notifications the list rendered past the bottom edge
    // of the sheet with no way to scroll. Root cause: SheetContent was a plain
    // block with no overflow handling, and the body wrapper had no flex sizing
    // so children grew unbounded. The shell now owns the scroll container so
    // every consumer of DesktopNotificationTray gets scroll for free.
    const sheetFlexPattern = /SheetContent[\s\S]*?className=["'][^"']*\bflex\b[^"']*\bflex-col\b/;
    if (!sheetFlexPattern.test(source)) {
      dumpTraySnapshot("scrollable-body", source, ["SheetContent ... className=...flex...flex-col"]);
    }
    expect(source).toMatch(sheetFlexPattern);
    // body wrapper must have flex sizing + scroll handling (order-independent)
    const bodyMatch = source.match(/<div\s+className=["']([^"']*)["']>\s*\{hasContent/);
    if (!bodyMatch) {
      dumpTraySnapshot("scrollable-body", source, ["<div className=...>{hasContent"]);
      throw new Error("could not locate body wrapper around {hasContent");
    }
    const bodyClasses = bodyMatch[1];
    console.info(`[notification-tray:scrollable-body] body wrapper classes=${JSON.stringify(bodyClasses)}`);
    if (
      !/\bflex-1\b/.test(bodyClasses) ||
      !/\bmin-h-0\b/.test(bodyClasses) ||
      !/\boverflow-y-auto\b/.test(bodyClasses)
    ) {
      console.error(
        `=== [notification-tray:scrollable-body] body wrapper missing required sizing/scroll classes ===`,
      );
      console.error(`body classes: ${JSON.stringify(bodyClasses)}`);
    }
    expect(bodyClasses).toMatch(/\bflex-1\b/);
    expect(bodyClasses).toMatch(/\bmin-h-0\b/);
    expect(bodyClasses).toMatch(/\boverflow-y-auto\b/);
  });

  it("prefers provided content over the empty state", () => {
    console.info(`[notification-tray:content-vs-empty] asserting hasContent branch wiring`);
    expectContains("content-vs-empty", source, "const hasContent = Boolean(children);");
    expectContains("content-vs-empty", source, "{hasContent ? (");
    expectContains("content-vs-empty", source, "children");
  });
});
