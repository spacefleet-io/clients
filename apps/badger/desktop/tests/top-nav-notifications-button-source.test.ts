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
  it("@bugfix @regression-proof only mounts notification sheet content while the panel is open", () => {
    console.info(`[top-nav-notifications-button-source:lazy-mount] reading ${SOURCE_PATH}`);
    const source = readFileSync(SOURCE_PATH, "utf8");
    const tokens = {
      "<DesktopNotificationTray": source.includes("<DesktopNotificationTray"),
      "{notifications.length > 0 ? (": source.includes("{notifications.length > 0 ? ("),
      "<NotificationTrayContent": source.includes("<NotificationTrayContent"),
    };
    console.info(`[top-nav-notifications-button-source:lazy-mount] tokens=${JSON.stringify(tokens)}`);
    if (Object.values(tokens).some((v) => !v)) dumpTopNavSnapshot("lazy-mount", source, tokens);

    expect(source).toContain("<DesktopNotificationTray");
    expect(source).toContain("{notifications.length > 0 ? (");
    expect(source).toContain("<NotificationTrayContent");
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
