import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BadgerLibraryControls, BadgerViewCycleButton, libraryFacetSections, type BadgerLibraryControlsLabels } from "../src/badger/library-toolbar";

const LOG = "[library-toolbar]";
const VIEWS = [
  { id: "posters", label: "Posters", icon: <svg /> },
  { id: "compact", label: "Compact list", icon: <svg /> },
  { id: "details", label: "Details list", icon: <svg /> },
] as const;
const list = { title: "Genres", placeholder: "Pick", search: "Search", empty: "None" };
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
      const html = renderToStaticMarkup(<BadgerViewCycleButton options={[...VIEWS]} value={value} onChange={() => {}} nextLabel={(option) => `Switch to ${option.label}`} testId="library-view-cycle" />);
      console.info(`${LOG} view=${value} html=${html.length}`);
      expect(html).toContain(`data-view="${value}"`);
      expect(html).toContain(`title="Switch to ${next}"`);
    }
  });

  it("is exactly Filter, Sort and the view button; Clear and the count only while filters are on", () => {
    console.info(`${LOG} phase=controls`);
    const idle = controls([], []);
    const filtered = controls(["878"], ["Brigitte Helm"]);
    const order = ["library-filter-button", "library-sort-button", "library-view-cycle"].map((id) => idle.indexOf(id));
    console.info(`${LOG} order=${JSON.stringify(order)} clearIdle=${idle.includes("library-filter-clear")}`);
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(idle).not.toContain("library-filter-clear");
    expect(filtered).toContain("library-filter-clear");
    expect(filtered).toContain(" · 2");
  });
});

// @req UX-LIB-03
describe("[library-toolbar] the extra Filter sections", () => {
  it("offers a section per facet the library holds, labelled, and counts their picks on the Filter button", () => {
    const sections = libraryFacetSections(
      { qualities: ["4k", "sd"], directors: ["fritz lang"], audioLanguages: ["de"], subtitleLanguages: [], watchStates: ["in-progress"] },
      (key) => key,
      "en"
    );
    const summary = sections.map((section) => `${section.facet}:${section.labels.title}:${section.options.map((option) => option.label).join("|")}`);
    console.info(`${LOG} sections=${JSON.stringify(summary)}`);
    expect(summary).toEqual([
      "qualities:library.filters.qualities.title:4K|library.filters.quality.sd",
      "directors:library.filters.directors.title:Fritz Lang",
      "audioLanguages:library.filters.audioLanguages.title:German",
      "watchStates:library.filters.watchStates.title:library.filters.watchState.in-progress",
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
