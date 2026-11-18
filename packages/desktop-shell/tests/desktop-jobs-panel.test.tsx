/**
 * @test-id DESKTOP-SHELL-JOBS-001
 * @level unit (static render of the shared Jobs sheet trigger, filter chips and empty state)
 * @why Chris 2026-11-12 (chat): Parrot gets the same flask Jobs item and side panel as Badger, so both apps render
 *   it from desktop-shell; the flask while idle, a spinner with the running count while jobs run.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DESKTOP_JOB_FILTERS, DesktopJobsEmpty, DesktopJobsFilterBar, DesktopJobsSheet } from "../src/components/desktop-jobs-panel";

const SUITE = "[desktop-jobs-panel]";

describe("shared desktop Jobs panel", () => {
  // @req UX-JOBS-01[badger-desktop]
  // @req UX-JOBS-01[parrot]
  it("idle, the trigger is the flask named after the panel; running, a spinner with the count capped at 99", () => {
    const idle = renderToStaticMarkup(
      <DesktopJobsSheet title="Jobs" subtitle="Active and recent jobs" activeCount={0} jobCount={0} testId="nav-jobs">
        <p>rows</p>
      </DesktopJobsSheet>
    );
    console.info(SUITE, "idle", idle);
    expect(idle).toContain('aria-label="Jobs"');
    expect(idle).toContain('data-testid="nav-jobs"');
    expect(idle).toContain("lucide-flask-conical");
    expect(idle).not.toContain("nav-jobs-running");
    const busy = renderToStaticMarkup(
      <DesktopJobsSheet title="Jobs" subtitle="Active and recent jobs" activeCount={120} jobCount={120} testId="nav-jobs">
        <p>rows</p>
      </DesktopJobsSheet>
    );
    console.info(SUITE, "busy", busy);
    expect(busy).toContain('data-testid="nav-jobs-running"');
    expect(busy).toContain("animate-spin");
    expect(busy).toContain(">99<");
  });

  // @req UX-JOBS-01[parrot]
  it("the filter bar shows the five chips with the app's words, the chosen one pressed", () => {
    const labels = { all: "Todo", active: "Activo", queued: "En cola", completed: "Completado", failed: "Fallido" };
    const html = renderToStaticMarkup(<DesktopJobsFilterBar value="failed" onChange={() => undefined} labels={labels} trailing={<span>extra</span>} />);
    console.info(SUITE, "filters", html);
    for (const level of DESKTOP_JOB_FILTERS) expect(html).toContain(`data-testid="jobs-filter-${level}"`);
    for (const word of Object.values(labels)) expect(html).toContain(word);
    expect(html).toMatch(/aria-pressed="true" data-testid="jobs-filter-failed"/);
    expect(html).toContain("extra");
    const empty = renderToStaticMarkup(<DesktopJobsEmpty title="No imports yet" subtitle="Imports you start with + show up here" />);
    expect(empty).toContain('data-testid="jobs-empty"');
    expect(empty).toContain("No imports yet");
  });
});
