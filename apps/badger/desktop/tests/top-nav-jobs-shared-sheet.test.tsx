// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-JOBS-SHEET-001
 * @level integration (real TopNavJobsSidebar on the shared desktop-shell Jobs sheet; job hooks and the lazy list mocked)
 * @why Chris 2026-11-12 (chat): Parrot gets Badger's flask Jobs item and panel, so Badger's now comes from
 *   `@space/desktop-shell` and must behave as before: the flask idle, a spinner with the active group count while
 *   jobs run, and the panel with its title opening on click.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[badger-top-nav-jobs-sheet]";
let activeGroups: Array<{ id: string }> = [];

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/labJobs", () => ({ useLabJobsData: () => ({ activeGroups }) }));
vi.mock("@/lib/runtimeIngestJobs", () => ({ useRuntimeIngestJobs: () => ({ jobs: [] }) }));
vi.mock("@/lib/crewBackfill", () => ({ useCrewBackfillProgress: () => null }));
vi.mock("@/components/HighTrafficDownloadsNotice", () => ({ default: () => null }));
vi.mock("../src/renderer/src/components/TopNavJobsSidebarContent", () => ({ default: () => <div data-testid="jobs-content">rows</div> }));

import TopNavJobsSidebar from "../src/renderer/src/components/TopNavJobsSidebar";

describe("Badger top-bar Jobs item on the shared sheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => root.render(<TopNavJobsSidebar />));
    for (let i = 0; i < 3; i += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await act(async () => promise);
    }
  };
  const trigger = () => container.querySelector('[data-testid="top-nav-jobs"]') as HTMLButtonElement | null;

  beforeEach(() => {
    activeGroups = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // @req UX-JOBS-01[badger-desktop]
  it("idle shows the flask named Jobs; with two active groups a spinner and the count 2; a click opens the panel", async () => {
    await render();
    console.info(SUITE, "idle", trigger()?.outerHTML.slice(0, 300));
    expect(trigger()?.getAttribute("aria-label")).toBe("nav.jobs.title");
    expect(trigger()?.querySelector(".lucide-flask-conical")).not.toBeNull();
    expect(container.querySelector('[data-testid="top-nav-jobs-running"]')).toBeNull();
    activeGroups = [{ id: "a" }, { id: "b" }];
    await render();
    console.info(SUITE, "busy", trigger()?.outerHTML.slice(0, 300));
    expect(container.querySelector('[data-testid="top-nav-jobs-running"]')).not.toBeNull();
    expect(trigger()?.textContent).toBe("2");
    await act(async () => trigger()?.click());
    await render();
    const panel = document.querySelector('[role="dialog"]');
    console.info(SUITE, "panel", panel?.textContent);
    expect(panel?.textContent).toContain("nav.jobs.title");
    expect(document.querySelector('[data-testid="jobs-content"]')?.textContent).toBe("rows");
  });
});
