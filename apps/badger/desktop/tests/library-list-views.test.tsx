// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/components/MediaImage", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("@/components/OfflineBadge", () => ({
  default: () => <span data-testid="offline-badge" />,
}));
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

import LibraryListRows, { type LibraryListRowModel } from "../src/renderer/src/pages/LibraryListViews";

const makeRow = (overrides: Partial<LibraryListRowModel> & { id: string }): LibraryListRowModel => ({
  title: `Title ${overrides.id}`,
  year: "2020",
  posterPath: null,
  overview: "A long synopsis.",
  genres: ["Drama"],
  seasonCount: null,
  runtimeMinutes: null,
  progressPct: 0,
  disabled: false,
  offlineFull: false,
  ghostStatus: null,
  processing: null,
  ...overrides,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

const renderRows = (rows: LibraryListRowModel[], view: "compact" | "details") => {
  const onOpen = vi.fn();
  const onPlay = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <LibraryListRows rows={rows} view={view} pendingPlayId={null} playPending={false} onOpen={onOpen} onPlay={onPlay} />,
    );
  });
  return { onOpen, onPlay, text: container.textContent ?? "" };
};

const playButtons = () => Array.from(container?.querySelectorAll("button") ?? []);
const keyDown = (element: Element | null, key: string) => {
  act(() => {
    element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};
const click = (element: Element | null) => {
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("LibraryListRows", () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("compact rows show title and year but leave the synopsis and genres to the details list", () => {
    const { text } = renderRows([makeRow({ id: "a" })], "compact");
    expect(text).toContain("Title a");
    expect(text).toContain("2020");
    expect(text).not.toContain("A long synopsis.");
    expect(text).not.toContain("Drama");
  });

  it("details rows show synopsis, genres, seasons and runtime", () => {
    const { text } = renderRows([makeRow({ id: "a", seasonCount: 3, runtimeMinutes: 135 })], "details");
    expect(text).toContain("A long synopsis.");
    expect(text).toContain("Drama");
    expect(text).toContain('library.row.seasons:{"count":3}');
    expect(text).toContain('library.row.runtimeHours:{"hours":2,"minutes":15}');
  });

  it("@req META-SRC-05[badger-desktop] shows no rating in the compact or the details list, even when the row holds one", () => {
    // A caller that still spreads a synced library row (which carries `rating`) must not get it on screen.
    const rated = { ...makeRow({ id: "r", seasonCount: 2 }), rating: 7.94 } as LibraryListRowModel;
    for (const view of ["compact", "details"] as const) {
      const { text } = renderRows([rated], view);
      console.info("[META-SRC-05] desktop list", view, JSON.stringify(text));
      expect(text).toContain("Title r");
      expect(text).not.toContain("★");
      expect(text).not.toMatch(/7[.,]9/);
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("falls back to a placeholder when a title has no synopsis", () => {
    const { text } = renderRows([makeRow({ id: "a", overview: null })], "details");
    expect(text).toContain("library.row.noOverview");
  });

  it("opens a title on click and plays without opening it", () => {
    const { onOpen, onPlay } = renderRows([makeRow({ id: "a" })], "compact");
    click(container?.querySelector('[data-testid="library-row-a"]') ?? null);
    expect(onOpen).toHaveBeenCalledWith("a");
    onOpen.mockClear();
    click(playButtons()[0] ?? null);
    expect(onPlay).toHaveBeenCalledWith("a");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a title from the keyboard when the row itself has focus", () => {
    const { onOpen, onPlay } = renderRows([makeRow({ id: "a" })], "compact");
    const rowElement = container?.querySelector('[data-testid="library-row-a"]') ?? null;
    keyDown(rowElement, "Enter");
    expect(onOpen).toHaveBeenCalledWith("a");
    onOpen.mockClear();
    keyDown(rowElement, " ");
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(onPlay).not.toHaveBeenCalled();
  });

  // @bugfix @regression-proof: Enter / Space on the focused Play button bubbled to the row and opened the details
  // instead of playing.
  it("@bugfix @regression-proof Enter and Space on the Play button do not open the row", () => {
    const { onOpen } = renderRows([makeRow({ id: "a" })], "compact");
    const play = playButtons()[0] ?? null;
    keyDown(play, "Enter");
    keyDown(play, " ");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("offers no Play button for titles without files or ghost imports, and ghost imports cannot be opened", () => {
    const { onOpen, text } = renderRows(
      [
        makeRow({ id: "nofile", disabled: true }),
        makeRow({ id: "ghost", disabled: true, ghostStatus: <span>Importing</span> }),
      ],
      "compact",
    );
    expect(playButtons()).toHaveLength(0);
    click(container?.querySelector('[data-testid="library-row-ghost"]') ?? null);
    expect(onOpen).not.toHaveBeenCalled();
    // A title without files is still a real library entry: its details open (to add files, edit or delete it).
    click(container?.querySelector('[data-testid="library-row-nofile"]') ?? null);
    expect(onOpen).toHaveBeenCalledWith("nofile");
    expect(text).toContain("Importing");
  });

  // @req OFFL-PLAY-03: offline, a title with nothing on this computer is greyed and neither opens nor plays; a
  // downloaded one keeps its colour and its Play button.
  it("greys an unavailable offline title, with no Play button, and does not open it", () => {
    const { onOpen, onPlay } = renderRows(
      [makeRow({ id: "away", unavailable: true }), makeRow({ id: "kept", offlineFull: true })],
      "details",
    );
    const away = container?.querySelector('[data-testid="library-row-away"]') ?? null;
    const kept = container?.querySelector('[data-testid="library-row-kept"]') ?? null;
    console.info(
      JSON.stringify({
        test: "OFFL-PLAY-03 list rows",
        awayClass: away?.className,
        awayUnavailable: away?.getAttribute("data-unavailable"),
        awayRole: away?.getAttribute("role"),
        keptUnavailable: kept?.getAttribute("data-unavailable"),
        playButtons: playButtons().map((b) => b.getAttribute("title") ?? b.textContent),
      }),
    );
    expect(away?.getAttribute("data-unavailable")).toBe("true");
    expect(away?.getAttribute("aria-disabled")).toBe("true");
    expect(away?.className).toContain("opacity-40");
    expect(away?.className).toContain("grayscale");
    expect(away?.getAttribute("role")).toBeNull();
    expect(kept?.getAttribute("data-unavailable")).toBeNull();
    expect(kept?.className).not.toContain("grayscale");
    expect(playButtons()).toHaveLength(1);
    click(away);
    keyDown(away, "Enter");
    expect(onOpen).not.toHaveBeenCalled();
    click(kept);
    expect(onOpen).toHaveBeenCalledWith("kept");
    expect(onPlay).not.toHaveBeenCalled();
  });
});
