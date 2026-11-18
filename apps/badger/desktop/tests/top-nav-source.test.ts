import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOP_NAV_PATH = join(process.cwd(), "src/renderer/src/components/TopNav.tsx");

// Dump-on-failure: report which forbidden tokens were found / which required
// tokens were missing in TopNav.tsx, plus a few surrounding context lines for
// each hit, so a source-grep regression is diagnosable without rerun.
const dumpTopNavSourceSnapshot = (
  label: string,
  source: string,
  forbidden: string[],
  required: string[],
) => {
  try {
    const lines = source.split("\n");
    const lineFor = (needle: string) => {
      const idx = lines.findIndex((l) => l.includes(needle));
      return idx >= 0 ? `L${idx + 1}: ${lines[idx]?.trim()}` : "(not found)";
    };
    console.error(`=== [top-nav-source:${label}] snapshot ===`);
    console.error(`file=${TOP_NAV_PATH} bytes=${source.length} lines=${lines.length}`);
    for (const f of forbidden) {
      console.error(`forbidden ${JSON.stringify(f)} present=${source.includes(f)} -> ${lineFor(f)}`);
    }
    for (const r of required) {
      console.error(`required ${JSON.stringify(r)} present=${source.includes(r)} -> ${lineFor(r)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("TopNav source", () => {
  it("@bugfix @regression-proof only mounts notification sheet content while the panel is open", () => {
    console.info(`[top-nav-source:mount-notifications-button] reading ${TOP_NAV_PATH}`);
    const source = readFileSync(TOP_NAV_PATH, "utf8");

    const required = ["<TopNavNotificationsButton"];
    if (!source.includes(required[0]!)) {
      dumpTopNavSourceSnapshot("mount-notifications-button", source, [], required);
    }
    expect(source).toContain("<TopNavNotificationsButton");
  });

  it("keeps notification tray state outside the main top nav shell", () => {
    console.info(`[top-nav-source:tray-state-extracted] reading ${TOP_NAV_PATH}`);
    const source = readFileSync(TOP_NAV_PATH, "utf8");

    const required = ['import TopNavNotificationsButton from "@/components/TopNavNotificationsButton";'];
    const forbidden = ["setNotifications("];
    const missingRequired = required.filter((r) => !source.includes(r));
    const presentForbidden = forbidden.filter((f) => source.includes(f));
    console.info(
      `[top-nav-source:tray-state-extracted] missingRequired=${JSON.stringify(missingRequired)} presentForbidden=${JSON.stringify(presentForbidden)}`,
    );
    if (missingRequired.length > 0 || presentForbidden.length > 0) {
      dumpTopNavSourceSnapshot("tray-state-extracted", source, forbidden, required);
    }
    expect(source).toContain('import TopNavNotificationsButton from "@/components/TopNavNotificationsButton";');
    expect(source).not.toContain("setNotifications(");
  });

  it("uses the shared desktop top nav shell", () => {
    console.info(`[top-nav-source:shared-shell] reading ${TOP_NAV_PATH}`);
    const source = readFileSync(TOP_NAV_PATH, "utf8");

    const required = ["DesktopAppTopNav"];
    if (!source.includes(required[0]!)) {
      dumpTopNavSourceSnapshot("shared-shell", source, [], required);
    }
    expect(source).toContain("DesktopAppTopNav");
  });

  it("memoizes the top nav shell so page rerenders do not always remount it", () => {
    console.info(`[top-nav-source:memoized] reading ${TOP_NAV_PATH}`);
    const source = readFileSync(TOP_NAV_PATH, "utf8");

    const required = ["export default memo(TopNav);"];
    if (!source.includes(required[0]!)) {
      dumpTopNavSourceSnapshot("memoized", source, [], required);
    }
    expect(source).toContain("export default memo(TopNav);");
  });
});
