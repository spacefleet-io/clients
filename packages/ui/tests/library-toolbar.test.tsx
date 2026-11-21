import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BadgerLibraryControls, libraryFacetSections, type BadgerLibraryControlsLabels } from "../src/badger/library-toolbar";
import { BadgerFilterPicker, FILTER_CHIP_LIMIT } from "../src/badger/library-menus";
import { LibraryViewCycleButton } from "../src/library-row";

const LOG = "[library-toolbar]";
const VIEWS = [
  { id: "posters", label: "Posters", icon: <svg /> },
  { id: "compact", label: "Compact list", icon: <svg /> },
  { id: "details", label: "Details list", icon: <svg /> },
] as const;
const list = { title: "Genres", search: "Search", empty: "None" };
const LABELS: BadgerLibraryControlsLabels = {
  filter: "Filter",
  clear: "Clear",
  reset: "Reset",
  apply: "Apply",
  sort: "Sort",
  sortTitle: "Sort by",
  sortBy: "By",
  sortDirection: "Direction",
  directionText: "Ascending",
  done: "Done",
  close: "Close",
  genres: list,
  actors: { ...list, title: "Actors" },
  nextView: (label) => `Switch to ${label}`,
  moreChoices: (count) => `+${count} more`,
};

const controls = (genres: string[], actors: string[]) =>
  renderToStaticMarkup(
    <BadgerLibraryControls
      labels={LABELS}
      genreOptions={[]}
      actorOptions={[]}
      genres={genres}
      actors={actors}
      onFiltersChange={() => {}}
      sortOptions={[{ value: "title", label: "Title" }]}
      sortBy="title"
      onSortByChange={() => {}}
      sortDirection="asc"
      onToggleSortDirection={() => {}}
      viewOptions={[...VIEWS]}
      view="posters"
      onViewChange={() => {}}
    />
  );

// @req UX-LIB-01
describe("[library-toolbar] the library row's controls", () => {
  it("shows the current view and names the next one, wrapping from details back to posters", () => {
    console.info(`${LOG} phase=cycle`);
    for (const [value, next] of [
      ["posters", "Compact list"],
      ["compact", "Details list"],
      ["details", "Posters"],
    ] as const) {
      const html = renderToStaticMarkup(<LibraryViewCycleButton options={[...VIEWS]} value={value} onChange={() => {}} nextLabel={(option) => `Switch to ${option.label}`} />);
      console.info(`${LOG} view=${value} html=${html.length}`);
      expect(html).toContain(`data-view="${value}"`);
      expect(html).toContain(`title="Switch to ${next}"`);
    }
  });
  it("is exactly Filter, Sort and the view button (the counts sit on the row's left); Clear and the count only while filters are on", () => {
    console.info(`${LOG} phase=controls`);
    const idle = controls([], []);
    const filtered = controls(["878"], ["Brigitte Helm"]);
    const order = ["library-filter-button", "library-sort-button", "library-view-cycle"].map((id) => idle.indexOf(id));
    console.info(`${LOG} order=${JSON.stringify(order)} clearIdle=${idle.includes("library-filter-clear")}`);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(idle).not.toContain("library-filter-clear");
    expect(idle).not.toContain("library-counts");
    expect(filtered).toContain("library-filter-clear");
    expect(filtered).toContain(" · 2");
  });
});

// @req UX-LIB-03
describe("[library-toolbar] the extra Filter sections", () => {
  it("offers watch state whole and each library-drawn kind with two or more choices, and counts picks on the Filter button", () => {
    const sections = libraryFacetSections(
      { qualities: ["4k", "sd"], directors: ["fritz lang"], audioLanguages: ["de"], subtitleLanguages: [], watchStates: ["in-progress"] },
      (key) => key,
      "en"
    );
    const summary = sections.map((section) => `${section.facet}:${section.labels.title}:${section.options.map((option) => option.label).join("|")}`);
    console.info(`${LOG} sections=${JSON.stringify(summary)}`);
    // One director and one audio language filter nothing, so they drop out; watch state always offers all three.
    expect(summary).toEqual([
      "qualities:library.filters.qualities.title:4K|library.filters.quality.sd",
      "watchStates:library.filters.watchStates.title:library.filters.watchState.unwatched|library.filters.watchState.in-progress|library.filters.watchState.watched",
    ]);
    const html = renderToStaticMarkup(
      <BadgerLibraryControls
        labels={LABELS}
        genreOptions={[]}
        actorOptions={[]}
        genres={["878"]}
        actors={[]}
        facetSections={sections}
        facets={{ qualities: ["sd"], watchStates: ["in-progress"] }}
        onFiltersChange={() => {}}
        sortOptions={[{ value: "title", label: "Title" }]}
        sortBy="title"
        onSortByChange={() => {}}
        sortDirection="asc"
        onToggleSortDirection={() => {}}
        viewOptions={[...VIEWS]}
        view="posters"
        onViewChange={() => {}}
      />
    );
    expect(html).toContain(" · 3");
  });
});

// @req UX-LIB-01[badger-desktop] @req UX-LIB-01[badger-web-player]
describe("[library-toolbar] a Filter list", () => {
  const options = (count: number) => Array.from({ length: count }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }));
  const picker = (count: number, selected: string[]) =>
    renderToStaticMarkup(<BadgerFilterPicker searchPlaceholder="Search actors" emptyText="None" moreLabel={(n) => `+${n} more`} options={options(count)} selected={selected} onChange={() => {}} />);

  it("is chips with no search up to the chip limit, each picked chip on, and nothing that scrolls inside it", () => {
    const html = picker(FILTER_CHIP_LIMIT, ["v2"]);
    const chips = html.match(/aria-pressed="(true|false)"/g) ?? [];
    console.info(`${LOG} short list chips=${chips.length} pressed=${chips.filter((chip) => chip.includes("true")).length}`);
    expect(chips).toHaveLength(FILTER_CHIP_LIMIT);
    expect(chips.filter((chip) => chip.includes("true"))).toHaveLength(1);
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/overflow-y|max-h-/);
  });

  it("adds a search past the limit, keeps picked chips first and ends with a \"+N more\" chip button", () => {
    const html = picker(FILTER_CHIP_LIMIT + 10, ["v20"]);
    const chips = html.match(/aria-pressed="(true|false)"/g) ?? [];
    console.info(`${LOG} long list chips=${chips.length} input=${html.includes("<input")}`);
    expect(html).toContain('placeholder="Search actors"');
    expect(chips).toHaveLength(FILTER_CHIP_LIMIT + 1);
    expect(chips[0]).toContain("true");
    // The "+N more" chip is a button (no aria-pressed: it is an action, not a pick).
    expect(html).toMatch(/<button[^>]*data-testid="library-filter-more"[^>]*>(?:(?!<\/button>).)*\+9 more/);
    expect(html).not.toMatch(/overflow-y|max-h-/);
  });
});
