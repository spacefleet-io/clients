import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BadgerContinueHero,
  BadgerPosterCard,
  BadgerPosterGrid,
  BadgerSegmented,
  formatBadgerRuntime,
} from "../src/badger/components";
import { MediaDetailPage } from "../src/badger/media-detail";
import { EmptyLibrary } from "../src/empty-library";

// The home and library pieces the Badger desktop renderer and web player will share (REL-FAM-02).
describe("[badger] home and library pieces", () => {
  it("formats the runtime", () => {
    expect(formatBadgerRuntime(4680)).toBe("1h 18m");
    expect(formatBadgerRuntime(3120)).toBe("52m");
  });

  it("the hero shows eyebrow, title, meta, Resume and Details", () => {
    const html = renderToStaticMarkup(
      <BadgerContinueHero eyebrow="Continue watching" title="The General" meta="1926 · 1h 18m · 37 min left" progressPct={53} poster={null} resumeLabel="Resume 41:12" detailsLabel="Details" onResume={() => undefined} onDetails={() => undefined} />,
    );
    console.info("[badger-home] hero", html.length);
    expect(html).toContain("text-[40px]");
    expect(html).toContain("1926 · 1h 18m · 37 min left");
    expect(html).toContain("Resume 41:12");
    expect(html).toContain('data-testid="continue-hero-details"');
    expect(html).toContain("width:53%");
  });

  it("the hero title uses the card's whole width and wraps to two lines before it is cut (UX-HOME-02)", () => {
    const title = "The Cartographer and the Keeper's Lantern";
    const html = renderToStaticMarkup(
      <BadgerContinueHero eyebrow="Continue watching" title={title} meta="2001" progressPct={10} poster={null} resumeLabel="Resume" detailsLabel="Details" onResume={() => undefined} onDetails={() => undefined} />,
    );
    const h1 = html.match(/<h1[^>]*>/)?.[0] ?? "";
    console.info("[badger-home] hero title", h1);
    expect(h1).toContain("line-clamp-2");
    expect(h1).not.toContain("truncate");
    expect(html).not.toContain("max-w-[620px]");
    expect(html).toContain("The Cartographer and the Keeper&#x27;s Lantern</h1>");
  });

  it("the detail page draws the backdrop with eased fades, never the poster; no backdrop = the plain sky (LIB-DETAIL-03)", () => {
    const page = (backdrop?: ReactNode) =>
      renderToStaticMarkup(
        <MediaDetailPage poster={<img src="poster.jpg" alt="" />} backdrop={backdrop} backLabel="Back" onBack={() => undefined} kindLabel="Movie" versions={[]} title="Metropolis" meta="1927" actions={null}>
          {null}
        </MediaDetailPage>,
      );
    const withBackdrop = page(<img src="backdrop.jpg" alt="" />);
    const plain = page();
    const layer = withBackdrop.match(/data-testid="media-detail-backdrop".*?<\/div><\/div>/)?.[0] ?? "";
    console.info("[badger-detail] backdrop layer", layer.length, layer.slice(0, 400));
    expect(layer).toContain("backdrop.jpg");
    expect(layer).not.toContain("poster.jpg");
    expect(layer).toContain("mask-image:linear-gradient(to right, rgba(0,0,0,0) 0.0%");
    expect(layer).toContain("linear-gradient(to bottom, rgba(0,0,0,1) 30.0%");
    expect(plain).not.toContain("media-detail-backdrop");
    expect(plain.match(/<img src="poster\.jpg"/g)).toHaveLength(1);
  });

  it("the grid has 7 columns; a card shows the watched tick or a progress line", () => {
    expect(renderToStaticMarkup(<BadgerPosterGrid>{null}</BadgerPosterGrid>)).toContain("repeat(7,minmax(0,1fr))");
    const done = renderToStaticMarkup(<BadgerPosterCard title="Metropolis" meta="1927 · Drama" poster={null} watched onOpen={() => undefined} />);
    const half = renderToStaticMarkup(<BadgerPosterCard title="Sherlock Jr." poster={null} progressPct={40} onOpen={() => undefined} />);
    expect(done).toContain("poster-card-done");
    expect(done).toContain("1927 · Drama");
    expect(half).not.toContain("poster-card-done");
    expect(half).toContain("width:40%");
  });

  it("the segmented toggle marks the picked tab; the empty library has the bare mascot and three steps", () => {
    const seg = renderToStaticMarkup(
      <BadgerSegmented ariaLabel="Kind" value="tv" onChange={() => undefined} options={[{ id: "movie", label: "Movies" }, { id: "tv", label: "TV shows" }]} />,
    );
    expect(seg).toContain('aria-selected="true"');
    expect(seg).toContain("h-8");
    const empty = renderToStaticMarkup(
      <EmptyLibrary
        mascotSrc="mascot.webp"
        mascotAlt="Astronaut badger"
        eyebrow="Your library"
        title="Add your first title"
        subtitle="Films and series from your computer"
        primary={{ label: "Add media", onClick: () => undefined }}
        secondary={{ label: "Add a folder", onClick: () => undefined }}
        steps={[{ title: "Pick your files", body: "a" }, { title: "Badger finds the details", body: "b" }, { title: "Watch anywhere", body: "c" }]}
      />,
    );
    expect(empty).toContain("drop-shadow-[0_0_22px_hsl(var(--primary)/0.35)]");
    expect(empty).toContain("1. Pick your files");
    expect(empty).toContain("3. Watch anywhere");
    expect(empty).toContain("Add a folder");
  });
});
