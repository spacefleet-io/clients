import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_LAYOUT_KEY, parseHomeLayout } from "@space/shared/homeLayout";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// The desktop's editable Home layout is the one every Badger app draws (UX-HOME-06):
// the desktop reads and saves it through the shared module the phone, TV and web player read.
describe("desktop Home layout is the shared one", () => {
  // @req UX-HOME-06[badger-desktop]
  it("[UX-HOME-06] the Home reads and saves the layout through @space/shared/homeLayout, under the synced key", () => {
    console.info("[UX-HOME-06-dsk] phase=start");
    const dashboard = read("src/renderer/src/pages/Dashboard.tsx");
    const editor = read("src/renderer/src/components/DashboardEditLayout.tsx");
    expect(dashboard).toContain('from "@space/shared/homeLayout"');
    expect(editor).toContain('from "@space/shared/homeLayout"');
    expect(dashboard).toContain("getSharedSetting(HOME_LAYOUT_KEY)");
    expect(dashboard).toContain("setSharedSetting(HOME_LAYOUT_KEY, payload)");
    expect(dashboard).toContain("parseHomeLayout(layoutSetting?.value");
    // No desktop-only copy of the layout types or parser is left behind.
    expect(dashboard).not.toContain("dashboardLayoutTypes");
    expect(editor).not.toContain("dashboardLayoutTypes");
    expect(HOME_LAYOUT_KEY).toBe("dashboard_layout_v1");
    console.info("[UX-HOME-06-dsk] phase=source-ok");
  });

  // @req UX-HOME-06[badger-desktop]
  it("[UX-HOME-06] a layout saved on the desktop parses back in its order for the other apps", () => {
    const raw = JSON.stringify({
      version: 1,
      sections: [
        { id: "a", type: "favorites", libraries: ["movies", "tv"], styleId: 2 },
        { id: "b", type: "recent", libraries: ["movies"], styleId: 0 },
        { id: "c", type: "continue", libraries: ["movies", "tv"], styleId: 1 },
      ],
    });
    const layout = parseHomeLayout(raw, []);
    console.info("[UX-HOME-06-dsk] phase=parsed", JSON.stringify(layout.map((s) => [s.id, s.type])));
    expect(layout.map((s) => s.type)).toEqual(["favorites", "recent", "continue"]);
    expect(layout.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
