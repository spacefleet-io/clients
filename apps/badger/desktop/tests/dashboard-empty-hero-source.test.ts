import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("badger dashboard empty library source contract", () => {
  // @req UX-EMPTY-01[badger-desktop]
  it("renders the shared empty-library card: freestanding mascot, Add media + Add a folder, three steps", () => {
    const dashboard = read("src/renderer/src/pages/Dashboard.tsx");
    expect(dashboard).toContain("<EmptyLibrary");
    expect(dashboard).not.toContain("DesktopWelcomeHero");
    expect(dashboard).not.toContain("empty-library-badge");
    expect(dashboard).toContain("mascotSrc={emptyLibraryBg}");
    expect(dashboard).toContain('primary={{ label: t("dashboard.empty.addMedia"), onClick: openIngestionFromDashboard');
    expect(dashboard).toContain('label: t("dashboard.empty.addFolder")');
    expect(dashboard).toContain('pickIngestion("openDirectory")');
    expect(dashboard).toContain("properties: [kind, \"multiSelections\"]");
    for (const step of [1, 2, 3]) expect(dashboard).toContain(`t("dashboard.empty.step${step}Title")`);

    const en = JSON.parse(read("src/renderer/src/i18n/en.json")) as { dashboard: { empty: Record<string, string> } };
    expect(en.dashboard.empty).toMatchObject({
      eyebrow: "Your library",
      title: "Add your first title",
      addMedia: "Add media",
      addFolder: "Add a folder",
    });
  });

  // @req UX-HOME-01[badger-desktop]
  it("shows the Continue watching hero and boxless rows on Home", () => {
    const dashboard = read("src/renderer/src/pages/Dashboard.tsx");
    expect(dashboard).toContain("<DashboardContinueHero");
    expect(dashboard).toContain("onDetails={(id) => navigate(mediaDetailPath(id, searchParams))}");
    expect(dashboard).toContain("<BadgerRowHead");
    expect(dashboard).not.toContain('className="dashboard-section space-panel text-white"\n                  data-style={section.styleId}');
    const hero = read("src/renderer/src/components/DashboardContinueHero.tsx");
    expect(hero).toContain("<BadgerContinueHero");
    // No playlist or language button; genre names read in the UI language (`i18n.language`) are not a button.
    expect(hero.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replaceAll("i18n.language", "")).not.toMatch(/playlist|language/i);
  });

  // @req UX-HOME-03[badger-desktop]
  it("[UX-HOME-03] shows importing titles as greyed cards in the normal Home rows, with no separate processing hero", () => {
    console.info("[UX-HOME-03:source] reading Dashboard.tsx and en.json");
    const dashboard = read("src/renderer/src/pages/Dashboard.tsx");
    expect(dashboard).not.toContain("dashboard.processing.heroTitle");
    expect(dashboard).not.toContain('heroState === "processing"');
    expect(dashboard).toContain("importing={ghosts}");
    expect(dashboard).toContain("dashboard-importing-${ghost.id}");
    expect(dashboard).toContain("dashboard-card-processing-${item.id}");
    expect(dashboard).toContain("renderActions && !unavailable && !disabled");
    expect(dashboard).toContain("playableMedia.length === 0 && importingCount === 0 && !editMode");

    const en = JSON.parse(read("src/renderer/src/i18n/en.json")) as { dashboard: Record<string, unknown> };
    expect(en.dashboard.processing).toBeUndefined();
  });
});
