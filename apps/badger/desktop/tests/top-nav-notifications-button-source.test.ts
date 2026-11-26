import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(
  process.cwd(),
  "src/renderer/src/components/TopNavNotificationsButton.tsx"
);

// On a missing-token failure, dump which expected source contract is absent so
// a regression in TopNavNotificationsButton.tsx is diagnosable from the CI log.
const dumpTopNavSnapshot = (
  label: string,
  source: string,
  tokens: Record<string, boolean>
) => {
  try {
    console.error(`=== [top-nav-notifications-button-source:${label}] snapshot ===`);
    console.error(`source path=${SOURCE_PATH} length=${source.length}`);
    console.error(`token presence: ${JSON.stringify(tokens)}`);
    const missing = Object.entries(tokens).filter(([, present]) => !present).map(([t]) => t);
    console.error(`missing tokens:\n${JSON.stringify(missing, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("TopNavNotificationsButton source", () => {
  it("@bugfix @regression-proof uses the shared bell, whose tray content only mounts while it is open", () => {
    // The "content only while open" half is proven on NoticeBell itself (packages/desktop-shell/tests/notice-bell.test.tsx).
    console.info(`[top-nav-notifications-button-source:shared-bell] reading ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    const tokens = {
      "<NoticeBell": source.includes("<NoticeBell"),
      "no own tray": !source.includes("<DesktopNotificationTray"),
    };
    console.info(`[top-nav-notifications-button-source:shared-bell] tokens=${JSON.stringify(tokens)}`);
    if (Object.values(tokens).some((v) => !v)) dumpTopNavSnapshot("shared-bell", source, tokens);

    expect(source).toContain("<NoticeBell");
    expect(source).not.toContain("<DesktopNotificationTray");
  });

  it("memoizes the notification tray shell so parent rerenders do not always remount it", () => {
    console.info(`[top-nav-notifications-button-source:memo] reading ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    const tokens = {
      "memo(TopNavNotificationsButton)": source.includes(
        "export default memo(TopNavNotificationsButton);"
      ),
    };
    console.info(`[top-nav-notifications-button-source:memo] tokens=${JSON.stringify(tokens)}`);
    if (Object.values(tokens).some((v) => !v)) dumpTopNavSnapshot("memo", source, tokens);

    expect(source).toContain("export default memo(TopNavNotificationsButton);");
  });
});
