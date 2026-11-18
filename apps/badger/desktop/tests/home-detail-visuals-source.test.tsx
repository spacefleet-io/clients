import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BadgerContinueHero } from "@space/ui/badger";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("badger desktop Home hero title and detail backdrop (Chris, 2026-11-09 hand-try)", () => {
  // @req UX-HOME-02[badger-desktop]
  it("the Home card is the shared hero, whose title spans the card and wraps to two lines before it is cut", () => {
    expect(read("src/renderer/src/components/DashboardContinueHero.tsx")).toContain("<BadgerContinueHero");
    const html = renderToStaticMarkup(
      <BadgerContinueHero eyebrow="Continue watching" title="Cartographer" meta="2001" progressPct={10} poster={null} resumeLabel="Resume" detailsLabel="Details" onResume={() => undefined} onDetails={() => undefined} />,
    );
    const h1 = html.match(/<h1[^>]*>/)?.[0] ?? "";
    console.info("[home-detail-visuals] desktop hero title", h1);
    expect(h1).toContain("line-clamp-2");
    expect(h1).not.toContain("truncate");
    expect(html).not.toContain("max-w-[620px]");
  });

  // @req LIB-DETAIL-03[badger-desktop]
  it("the detail page passes the title's backdrop as the backdrop, never the poster", () => {
    const dialog = read("src/renderer/src/components/MediaDetailsDialog.tsx");
    const backdrop = dialog.match(/backdrop=\{[^\n]*\n/)?.[0] ?? "";
    console.info("[home-detail-visuals] desktop backdrop prop", backdrop.trim());
    expect(backdrop).toContain("selectedDetails.backdropPath ?");
    expect(backdrop).toContain('kind="backdrop"');
    expect(backdrop).not.toContain("posterPath");
    expect(backdrop).toContain(": undefined");
  });
});
