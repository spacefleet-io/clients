/**
 * @test-id DESKTOP-SHELL-JOBS-002
 * @level unit (static render of the shared job cards; source check that both apps draw their jobs with them)
 * @why Chris 2026-11-16 (chat, via Main): Parrot's import jobs looked different from Badger's because each app drew its
 *   own cards. Both apps now draw them from desktop-shell: the same pills, X and bin, progress bar, finished row,
 *   loading cards, quiet background line and a title's empty Jobs tab.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesktopCompletedJobRow,
  DesktopJobActionButton,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobStatusPill,
  DesktopJobsBackgroundLine,
  DesktopJobsLoadingSkeleton,
  DesktopJobsTabEmpty,
  DesktopFailedJobDetail,
  DesktopJobFailureGroups,
} from "../src/components/desktop-job-card";

const SUITE = "[desktop-job-card]";
const repo = join(__dirname, "../../..");
const source = (path: string) => readFileSync(join(repo, path), "utf8");

describe("shared desktop job cards", () => {
  // @req UX-JOBS-02[badger-desktop]
  // @req UX-JOBS-02[parrot]
  it("a running row has its pill, the bar with its rounded percentage and the X named after its action", () => {
    const html = renderToStaticMarkup(
      <DesktopJobRow
        title="Meltway"
        filename="/music/Meltway"
        badge={<DesktopJobStatusPill tone="cyan">Uploading</DesktopJobStatusPill>}
        progress={<DesktopJobProgress percent={41.6} speedLabel="3 MB/s" />}
        action={<DesktopJobActionButton kind="cancel" label="Cancel" onClick={() => undefined} testId="job-cancel" />}
      />
    );
    console.info(SUITE, "running row", html);
    expect(html).toContain("Meltway");
    expect(html).toContain("bg-cyan-500/20");
    expect(html).toContain(">42%<");
    expect(html).toContain("3 MB/s");
    expect(html).toContain('aria-label="Cancel"');
    expect(html).toContain('title="Cancel"');
    expect(html).toContain("lucide-x");
  });

  // @req UX-JOBS-02[badger-desktop]
  // @req UX-JOBS-02[parrot]
  it("a finished row has the bin, and animates its removal only when the list asks for it", () => {
    const row = (removing?: boolean) =>
      renderToStaticMarkup(
        <DesktopCompletedJobRow
          removing={removing}
          title="Meltway"
          meta="16/11/2026"
          badge={<DesktopJobStatusPill tone="emerald">Done</DesktopJobStatusPill>}
          action={<DesktopJobActionButton kind="remove" label="Remove from history" onClick={() => undefined} />}
        />
      );
    const plain = row();
    const animated = row(true);
    console.info(SUITE, "finished rows", plain, animated);
    expect(plain).toMatch(/lucide-trash/);
    expect(plain).toContain('aria-label="Remove from history"');
    expect(plain).not.toContain("grid-rows-[1fr]");
    expect(animated).toContain("grid-rows-[0fr]");
    expect(row(false)).toContain("grid-rows-[1fr]");
  });

  // @req UX-JOBS-02[badger-desktop]
  // @req UX-JOBS-02[parrot]
  it("the loading cards, the quiet line and the empty Jobs tab", () => {
    const cards = renderToStaticMarkup(<DesktopJobsLoadingSkeleton testId="jobs-loading" />);
    const rows = renderToStaticMarkup(<DesktopJobsLoadingSkeleton variant="row" testId="tab-loading" />);
    expect(cards.match(/animate-pulse/g)).toHaveLength(3);
    expect(rows.match(/animate-pulse/g)).toHaveLength(2);
    const line = renderToStaticMarkup(<DesktopJobsBackgroundLine testId="bg">Looking up lyrics (3 of 12)</DesktopJobsBackgroundLine>);
    expect(line).toContain("Looking up lyrics (3 of 12)");
    const empty = renderToStaticMarkup(<DesktopJobsTabEmpty title="All caught up" subtitle="No active or recent jobs." />);
    expect(empty).toContain("All caught up");
  });

  // @req UX-JOBS-03[badger-desktop]
  // @req UX-JOBS-03[parrot]
  it("a failed job says what happened, what it means and offers at most one action", () => {
    const withAction = renderToStaticMarkup(
      <DesktopFailedJobDetail
        what="The upload stopped."
        meaning="The processed copy is kept on this computer, so only the upload runs again."
        action={{ label: "Upload again", onClick: () => undefined, testId: "failed-action" }}
        testId="failed-detail"
      />
    );
    console.info(SUITE, "failed detail with action", withAction);
    expect(withAction).toContain("The upload stopped.");
    expect(withAction).toContain("only the upload runs again");
    expect(withAction.match(/<button/g)).toHaveLength(1);
    expect(withAction).toContain('data-testid="failed-action"');

    const busy = renderToStaticMarkup(
      <DesktopFailedJobDetail what="x" meaning="y" action={{ label: "Upload again", onClick: () => undefined, busy: true }} />
    );
    expect(busy).toContain("disabled");

    const removeOnly = renderToStaticMarkup(<DesktopFailedJobDetail what="The file was deleted." meaning="Nothing to import." />);
    console.info(SUITE, "failed detail without action", removeOnly);
    expect(removeOnly).not.toContain("<button");
  });

  // @req UX-JOBS-03[parrot]
  it("the files a job could not take read as one line per reason, their names behind a disclosure", () => {
    const html = renderToStaticMarkup(
      <DesktopJobFailureGroups
        testId="failures"
        filesLabel="Show files"
        groups={[
          { key: "missing", label: "2 files not found: they were moved or deleted after you chose them.", files: ["01 A.m4a", "02 B.m4a"] },
          { key: "unsupported", label: "1 file is not a song Parrot can import.", files: ["cover.pdf"] },
        ]}
      />
    );
    console.info(SUITE, "failure groups", html);
    expect(html.match(/<details>/g)).toHaveLength(2);
    expect(html).toContain('data-reason="missing"');
    expect(html).toContain("2 files not found");
    expect(html).toContain("<li class=\"truncate py-0.5\">02 B.m4a</li>");
    expect(renderToStaticMarkup(<DesktopJobFailureGroups groups={[]} filesLabel="Show files" />)).toBe("");
  });

  // @req UX-JOBS-02[badger-desktop]
  // @req UX-JOBS-02[parrot]
  // @req UX-JOBS-03[badger-desktop]
  // @req UX-JOBS-03[parrot]
  it("both apps draw their jobs with these cards, not their own", () => {
    const badger = {
      panel: source("apps/badger/desktop/src/renderer/src/components/TopNavJobsSidebarContent.tsx"),
      sheet: source("apps/badger/desktop/src/renderer/src/components/TopNavJobsSidebar.tsx"),
      tab: source("apps/badger/desktop/src/renderer/src/components/MediaDetailsProcessingPanel.tsx"),
      pill: source("apps/badger/desktop/src/renderer/src/components/LabStatusBadge.tsx"),
      failed: source("apps/badger/desktop/src/renderer/src/components/FailedImportDetail.tsx"),
    };
    const parrot = source("apps/parrot/desktop/src/renderer/src/ImportJobs.tsx");
    for (const part of ["DesktopJobGroupCard", "DesktopJobRow", "DesktopCompletedJobRow", "DesktopJobActionButton", "DesktopJobsLoadingSkeleton", "useStaggeredDismiss"]) {
      expect(badger.panel, `Badger panel uses ${part}`).toContain(part);
    }
    // UX-JOBS-03: a failed import's three lines are the shared card, drawn in the panel through FailedImportDetail.
    expect(badger.failed).toContain("DesktopFailedJobDetail");
    expect(badger.panel).toContain("FailedImportDetail");
    expect(badger.sheet).toContain("DesktopJobsBackgroundLine");
    for (const part of ["DesktopJobRow", "DesktopCompletedJobRow", "DesktopJobsTabEmpty"]) expect(badger.tab, `Badger Jobs tab uses ${part}`).toContain(part);
    expect(badger.pill).toContain("DesktopJobStatusPill");
    for (const part of ["DesktopJobGroupCard", "DesktopJobRow", "DesktopCompletedJobRow", "DesktopJobStatusPill", "DesktopJobActionButton", "DesktopJobProgress", "DesktopJobsLoadingSkeleton", "DesktopJobsBackgroundLine", "useStaggeredDismiss", "DesktopFailedJobDetail", "DesktopJobFailureGroups"]) {
      expect(parrot, `Parrot panel uses ${part}`).toContain(part);
    }
    // No hand-drawn pill, bin or failures list left in Parrot's panel; no raw error reaches the card.
    expect(parrot).not.toContain("lucide-react");
    expect(parrot).not.toContain("failure.error}");
  });
});
