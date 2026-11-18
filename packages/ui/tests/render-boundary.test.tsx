// @vitest-environment jsdom
// @req UX-CRASH-01[badger-desktop] @bugfix @regression-proof: one broken element blanks only itself (Chris, 2026-11-09).
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { emptyHistory } from "@space/parrot-core";
import ParrotHome from "../../../apps/parrot/desktop/src/renderer/src/Home";
import { translator } from "../../../apps/parrot/desktop/src/renderer/src/i18n";
import { Dialog, DialogContent, DialogTitle } from "../src/dialog";
import { Sheet, SheetContent, SheetTitle } from "../src/sheet";
import { ParrotMenu } from "../src/parrot/menu";
import { SearchPalette } from "../src/search-palette";
import { RENDER_ERROR_COPY, popupCrashNotice } from "@space/shared/renderError";
import { RenderBoundary, renderErrorCopy } from "../src/render-boundary";

const log = (message: string, extra?: unknown) => console.info(`[render-boundary.test] ${message}`, extra ?? "");

let shouldThrow = true;
const Bomb = ({ label }: { label: string }) => {
  if (shouldThrow) throw new Error(`boom in ${label}`);
  return <p>{label} works</p>;
};

/** Sets state on every commit: React aborts with "Maximum update depth exceeded" (the loop Chris hit). */
const UpdateLoop = () => {
  const [count, setCount] = React.useState(0);
  React.useLayoutEffect(() => setCount(count + 1));
  return <p>{count}</p>;
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <RenderBoundary name="app" variant="screen">
    <header>top bar</header>
    <main>{children}</main>
  </RenderBoundary>
);

/** The pop-up is gone and the window guard says it closed; OK clears the message. */
const expectClosedNotice = (name: string) => {
  expect(screen.getByText("top bar")).toBeTruthy();
  expect(screen.getByText("library")).toBeTruthy();
  expect(screen.queryByTestId("render-boundary-screen")).toBeNull();
  expect(screen.queryByTestId("render-boundary-overlay")).toBeNull();
  const notice = screen.getByTestId("render-boundary-popup-closed");
  expect(notice.getAttribute("data-boundary")).toBe(name);
  expect(notice.textContent).toContain(RENDER_ERROR_COPY.en.popupClosed);
  fireEvent.click(screen.getByRole("button", { name: RENDER_ERROR_COPY.en.dismiss }));
  expect(screen.queryByTestId("render-boundary-popup-closed")).toBeNull();
};

describe("RenderBoundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    shouldThrow = true;
    document.documentElement.lang = "en";
    // React reports every caught error to console.error; keep them, but count them instead of flooding the run.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    log("console.error calls", errorSpy.mock.calls.map((call: unknown[]) => String(call[0]).slice(0, 160)));
    errorSpy.mockRestore();
    cleanup();
    act(() => popupCrashNotice.dismiss());
  });

  it("closes a controlled dialog whose child throws and tells the user, keeping the app shell", () => {
    const onOpenChange = vi.fn();
    render(
      <Shell>
        <p>library</p>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Versions</DialogTitle>
            <Bomb label="dialog body" />
          </DialogContent>
        </Dialog>
      </Shell>,
    );
    log("dom after crash", document.body.innerHTML.slice(0, 600));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Versions")).toBeNull();
    expectClosedNotice("dialog");
  });

  it("closes an uncontrolled dialog whose child throws", () => {
    render(
      <Shell>
        <p>library</p>
        <Dialog defaultOpen>
          <DialogContent>
            <DialogTitle>Versions</DialogTitle>
            <Bomb label="dialog body" />
          </DialogContent>
        </Dialog>
      </Shell>,
    );
    expect(screen.queryByText("Versions")).toBeNull();
    expectClosedNotice("dialog");
  });

  it("closes a dialog stuck in an update-depth loop instead of unmounting the app", () => {
    render(
      <Shell>
        <p>library</p>
        <Dialog defaultOpen>
          <DialogContent>
            <DialogTitle>Loop</DialogTitle>
            <UpdateLoop />
          </DialogContent>
        </Dialog>
      </Shell>,
    );
    const caught = errorSpy.mock.calls.some((call: unknown[]) => call.some((arg: unknown) => String(arg).includes("Maximum update depth")));
    log("update loop caught", caught);
    expect(caught).toBe(true);
    expect(screen.queryByText("Loop")).toBeNull();
    expectClosedNotice("dialog");
  });

  it("closes a sheet whose child throws", () => {
    render(
      <Shell>
        <p>library</p>
        <Sheet defaultOpen>
          <SheetContent>
            <SheetTitle>Filters</SheetTitle>
            <Bomb label="sheet body" />
          </SheetContent>
        </Sheet>
      </Shell>,
    );
    expect(screen.queryByText("Filters")).toBeNull();
    expectClosedNotice("sheet");
  });

  it("closes the Parrot menu when an item throws", () => {
    const BadIcon = () => {
      throw new Error("boom in menu icon");
    };
    render(
      <Shell>
        <p>library</p>
        <ParrotMenu label="More" testId="more" items={[{ id: "bad", label: "Bad", icon: <BadIcon />, onSelect: () => undefined }]} />
      </Shell>,
    );
    fireEvent.click(screen.getByTestId("more"));
    expect(screen.queryByTestId("more-list")).toBeNull();
    expect(screen.getByTestId("more").getAttribute("aria-expanded")).toBe("false");
    expectClosedNotice("menu");
  });

  it("closes the search palette when its own body throws", () => {
    const onOpenChange = vi.fn();
    const BadHint = () => {
      throw new Error("boom in palette hint");
    };
    // A result is guarded on its own (item placeholder); a throw outside the results closes the palette.
    const labels = { title: "Search", placeholder: "Search…", empty: "Nothing", hint: (<BadHint />) as unknown as string, matchedVia: "via", kinds: { movie: "Movie" } };
    render(
      <Shell>
        <p>library</p>
        <SearchPalette open onOpenChange={onOpenChange} items={[{ key: "a", kind: "movie", title: "Hollow Star" }]} labels={labels} onSelect={() => undefined} />
      </Shell>,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("search-palette")).toBeNull();
    expectClosedNotice("search-palette");
  });

  it("shows a placeholder for one search result that throws; the other results stay", () => {
    const BadArt = () => {
      throw new Error("boom in palette artwork");
    };
    const labels = { title: "Search", placeholder: "Search…", empty: "Nothing", hint: "Type", matchedVia: "via", kinds: { movie: "Movie" } };
    render(
      <Shell>
        <SearchPalette
          open
          onOpenChange={() => undefined}
          items={[
            { key: "a", kind: "movie", title: "Hollow Star", image: "hollow-star.jpg" },
            { key: "b", kind: "movie", title: "Hollow Stars" },
          ]}
          labels={labels}
          onSelect={() => undefined}
          renderImage={() => <BadArt />}
        />
      </Shell>,
    );
    fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "Hollow Star" } });
    const placeholders = screen.getAllByTestId("render-boundary-item");
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].getAttribute("data-boundary")).toBe("search-result:a");
    expect(placeholders[0].textContent).toBe(RENDER_ERROR_COPY.en.itemFailed);
    expect(screen.getByText("Hollow Stars")).toBeTruthy();
    expect(screen.getByTestId("search-palette")).toBeTruthy();
  });

  it("shows the full-window screen with its one button, Try again, when nothing closer catches", () => {
    render(
      <RenderBoundary name="app" variant="screen">
        <Bomb label="route" />
      </RenderBoundary>,
    );
    const window = screen.getByTestId("render-boundary-screen");
    expect(window.textContent).toContain(RENDER_ERROR_COPY.en.detail);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again"]);
    // Without a brand (a route guard inside the window) there is no mascot and no sky of its own.
    expect(screen.queryByTestId("render-boundary-mascot")).toBeNull();
    expect(screen.queryByTestId("app-backdrop")).toBeNull();
  });

  // @req UX-CRASH-01[badger-desktop]: the whole-window crash screen wears the sign-in screen's sky and mascot (Chris, 2026-11-10).
  it("the whole-window guard shows the star sky, the app's mascot and '<App> needs to restart this screen.'", async () => {
    render(
      <RenderBoundary name="app" variant="screen" brand={{ app: "badger", mascotSrc: "/badger.webp", drawSky: true }}>
        <Bomb label="app" />
      </RenderBoundary>,
    );
    const window = screen.getByTestId("render-boundary-screen");
    expect(window.textContent).toContain("Something went wrong");
    expect(window.textContent).toContain("Badger needs to restart this screen.");
    expect(window.textContent).not.toContain(RENDER_ERROR_COPY.en.detail);
    const mascot = screen.getByTestId("render-boundary-mascot");
    expect(mascot.querySelector("img")?.getAttribute("src")).toBe("/badger.webp");
    expect(mascot.querySelector("img")?.className).toContain("drop-shadow-[0_0_30px_rgba(255,170,84,0.3)]");
    // The sky is loaded on the crash, then drawn with Badger's nebula behind the notice.
    const sky = await screen.findByTestId("app-backdrop");
    expect(window.contains(sky)).toBe(true);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again"]);
    log("branded window screen", window.textContent);
  });

  it("the app name is filled into each language, and an app whose sky sits outside the guard gets no second sky", () => {
    document.documentElement.lang = "fr";
    render(
      <RenderBoundary name="app" variant="screen" className="bg-transparent" brand={{ app: "parrot", mascotSrc: "/parrot.webp" }}>
        <Bomb label="app" />
      </RenderBoundary>,
    );
    expect(screen.getByTestId("render-boundary-screen").textContent).toContain("Parrot doit redémarrer cet écran.");
    expect(screen.getByTestId("render-boundary-mascot").querySelector("img")?.className).toContain("rgba(64,221,143,0.3)");
    expect(screen.queryByTestId("app-backdrop")).toBeNull();
    for (const lang of ["en", "fr", "nl", "de", "es"] as const) {
      expect(RENDER_ERROR_COPY[lang].windowDetail).toContain("{{app}}");
    }
  });

  it("an item or row guard keeps its small plain notice: no sky, no mascot", () => {
    render(
      <Shell>
        <RenderBoundary name="home-row:recent">
          <Bomb label="row" />
        </RenderBoundary>
      </Shell>,
    );
    const notice = screen.getByTestId("render-boundary-section");
    expect(notice.textContent).toContain(RENDER_ERROR_COPY.en.message);
    expect(screen.queryByTestId("render-boundary-mascot")).toBeNull();
    expect(screen.queryByTestId("app-backdrop")).toBeNull();
  });

  it("clears the error when the reset key changes (leaving the route)", () => {
    const view = render(
      <RenderBoundary name="route" resetKey="/media/1">
        <Bomb label="detail" />
      </RenderBoundary>,
    );
    expect(screen.getByTestId("render-boundary-section")).toBeTruthy();
    shouldThrow = false;
    act(() => {
      view.rerender(
        <RenderBoundary name="route" resetKey="/media-library">
          <Bomb label="library" />
        </RenderBoundary>,
      );
    });
    expect(screen.getByText("library works")).toBeTruthy();
  });

  it("speaks the app's five languages, following <html lang>", () => {
    for (const lang of ["en", "fr", "nl", "de", "es"] as const) {
      document.documentElement.lang = lang;
      expect(renderErrorCopy()).toBe(RENDER_ERROR_COPY[lang]);
    }
    expect(renderErrorCopy("de-DE").retry).toBe("Erneut versuchen");
    expect(renderErrorCopy("es-MX").retry).toBe("Volver a intentarlo");
    expect(renderErrorCopy("ja")).toBe(RENDER_ERROR_COPY.en);
  });

  it("catches a throw while a render function builds the guarded element (`{() => page()}`)", () => {
    const page = (): React.ReactNode => {
      if (shouldThrow) throw new Error("boom while building the page");
      return <p>page works</p>;
    };
    render(
      <Shell>
        <RenderBoundary name="route:home">{() => page()}</RenderBoundary>
      </Shell>,
    );
    expect(screen.getByText("top bar")).toBeTruthy();
    expect(screen.getByTestId("render-boundary-section").getAttribute("data-boundary")).toBe("route:home");
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("page works")).toBeTruthy();
  });
});

// @req UX-CRASH-01[parrot]: the real app screens keep their other rows up (the Badger web player's case lives in
// render-boundary.web-apps.test.tsx).
describe("app screens behind their guards", () => {
  let errorSpy: MockInstance;
  beforeEach(() => {
    document.documentElement.lang = "en";
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    log("console.error calls", errorSpy.mock.calls.map((call: unknown[]) => String(call[0]).slice(0, 160)));
    errorSpy.mockRestore();
    cleanup();
  });

  it("Parrot desktop Home: a crashing artist shows a placeholder in its place; the rows stay", async () => {
    const album = { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 1, coverUrl: null, coverThumbUrl: null };
    const track = { id: "t1", title: "Dawn", albumId: "alb-1", albumTitle: "First Light", artistId: "art-1", artistName: "Test Band", disc: 1, number: 1, durationMs: 180_000, fileId: "f1", mime: "audio/flac", sizeBytes: 1 };
    // A name that is not a string makes the shared artist circle throw while rendering, as a corrupt library row would.
    const brokenArtist = { id: "art-1", name: { broken: true } as unknown as string, albumCount: 1, trackCount: 1 };
    render(
      <Shell>
        <ParrotHome
          t={translator("en")}
          language="en"
          albums={[album] as never}
          artists={[brokenArtist] as never}
          tracks={[track] as never}
          history={emptyHistory()}
          playingTrack={undefined}
          playing={false}
          positionMs={0}
          onToggle={() => undefined}
          onOpenAlbum={() => undefined}
          onOpenArtist={() => undefined}
          onPlayAlbum={() => undefined}
          onSeeAll={() => undefined}
          onAddMusic={() => undefined}
          onAddFolder={() => undefined}
        />
      </Shell>,
    );
    log("parrot home after crash", document.body.innerHTML.slice(0, 600));
    expect(screen.getByText("top bar")).toBeTruthy();
    expect(screen.queryByTestId("render-boundary-screen")).toBeNull();
    expect(screen.queryByTestId("render-boundary-section")).toBeNull();
    const [placeholder] = screen.getAllByTestId("render-boundary-item");
    expect(placeholder.getAttribute("data-boundary")).toMatch(/art-1$/);
    expect(placeholder.textContent).toBe(RENDER_ERROR_COPY.en.itemFailed);
    expect(screen.getByTestId("home-recent")).toBeTruthy();
    expect(screen.getAllByText("First Light").length).toBeGreaterThan(0);
  });
});
