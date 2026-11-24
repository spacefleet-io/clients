// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-CRASH-HOME-001
 * @level integration (Parrot desktop's real Home and translator inside the shared RenderBoundary; no IPC)
 * @req UX-CRASH-01[parrot]
 * @why Chris, 2026-11-09: "no visual element should crash the app". On Parrot desktop's Home, one artist whose stored
 *   row is corrupt (a name that is not a string makes the shared artist circle throw while rendering) shows the item
 *   placeholder "This item can't be shown." in its own place; the screen guard, the Recent row and the albums stay up.
 *   This case lived in packages/ui/tests/render-boundary.test.tsx, which imported this app's sources; a shared
 *   package's tests import no app (#3350 S12), so it runs with the app's own suite.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { emptyHistory } from "@space/parrot-core";
import { RENDER_ERROR_COPY } from "@space/shared/renderError";
import { RenderBoundary } from "@space/ui/render-boundary";
import Home from "../src/renderer/src/Home";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-CRASH-HOME-001]";
const log = (event: string, data?: unknown) => console.info(`${SUITE} ${event}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

/** The app's window guard with a top bar, as `main.tsx` wraps every screen. */
const Shell = ({ children }: { children: React.ReactNode }) => (
  <RenderBoundary name="app" variant="screen">
    <header>top bar</header>
    <main>{children}</main>
  </RenderBoundary>
);

describe("Parrot desktop Home behind its guards (UX-CRASH-01)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let errorSpy: MockInstance;
  const q = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

  beforeEach(() => {
    document.documentElement.lang = "en";
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    log("console.error calls", errorSpy.mock.calls.map((call: unknown[]) => String(call[0]).slice(0, 160)));
    errorSpy.mockRestore();
    act(() => root.unmount());
    container.remove();
  });

  it("a crashing artist shows a placeholder in its place; the rows stay", async () => {
    const album = { id: "alb-1", title: "First Light", artistId: "art-1", artistName: "Test Band", year: 2020, trackCount: 1, coverUrl: null, coverThumbUrl: null };
    const track = { id: "t1", title: "Dawn", albumId: "alb-1", albumTitle: "First Light", artistId: "art-1", artistName: "Test Band", disc: 1, number: 1, durationMs: 180_000, fileId: "f1", mime: "audio/flac", sizeBytes: 1 };
    // A name that is not a string makes the shared artist circle throw while rendering, as a corrupt library row would.
    const brokenArtist = { id: "art-1", name: { broken: true } as unknown as string, albumCount: 1, trackCount: 1 };
    log("phase: render Home with one broken artist");
    await act(async () =>
      root.render(
        <Shell>
          <Home
            t={translator("en")}
            language="en"
            albums={[album] as never}
            artists={[brokenArtist] as never}
            content="ready"
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
      ),
    );
    log("phase: rendered", container.innerHTML.slice(0, 600));
    expect(container.textContent).toContain("top bar");
    expect(q("render-boundary-screen")).toHaveLength(0);
    expect(q("render-boundary-section")).toHaveLength(0);
    const placeholders = q("render-boundary-item");
    log("phase: placeholders", placeholders.map((el) => [el.getAttribute("data-boundary"), el.textContent]));
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].getAttribute("data-boundary")).toMatch(/art-1$/);
    expect(placeholders[0].textContent).toBe(RENDER_ERROR_COPY.en.itemFailed);
    expect(q("home-recent")).toHaveLength(1);
    expect(container.textContent).toContain("First Light");
    log("phase: done");
  });
});
