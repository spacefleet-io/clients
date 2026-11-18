// @vitest-environment jsdom
//
// B1 follow-up: when an active job is in the running phase, the badge text
// should reflect the live `stageLabel` (Extracting, Uploading, Committing,
// Transcoding 360p) instead of the coarse status word. Color tied to status
// stays as-is.
//
// - status="uploading" + stageLabel="Extracting" → badge text "Extracting"
// - status="transcoding" + stageLabel="Transcoding 360p" → "Transcoding 360p"
// - status="uploading" + stageLabel undefined → falls back to localized "uploading"
// - status="uploading" + stageLabel "uploading" (case match) → falls back (no echo)
// - terminal statuses ignore stageLabel (won't render it)

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const dict: Record<string, string> = {
        "lab.status.waiting": "Waiting",
        "lab.status.identifying": "Identifying",
        "lab.status.needsMatch": "Needs match",
        "lab.status.ready": "Ready",
        "lab.status.transcoding": "Transcoding",
        "lab.status.uploading": "Uploading",
        "lab.status.done": "Done",
        "lab.status.failed": "Failed",
        "lab.status.cancelled": "Cancelled",
      };
      return dict[key] ?? fallback ?? key;
    },
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// On a badge-text/color assertion failure, dump the rendered text + the
// span's class list so the mismatch (wrong stageLabel resolution, missing
// fallback, wrong color tier) is visible in CI. Wrapped in try/catch so a
// dump failure can't mask the assertion.
const dumpLabStatusBadgeSnapshot = (label: string, container: HTMLElement | null) => {
  try {
    const span = container?.querySelector("span");
    console.error(`=== [lab-status-badge-stage-label:${label}] snapshot ===`);
    console.error(`container.textContent=${JSON.stringify(container?.textContent ?? null)}`);
    console.error(`span.className=${JSON.stringify(span?.className ?? null)}`);
    console.error(`container.innerHTML=${JSON.stringify(container?.innerHTML ?? null)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const render = async (element: React.ReactElement) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
};

afterEach(() => {
  if (root && container) act(() => root?.unmount());
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
});

describe("[@bugfix][@regression-proof] B1 LabStatusBadge surfaces stageLabel for live phases", () => {
  it("source running with stageLabel='Extracting' → badge text is 'Extracting'", async () => {
    console.info("[lab-status-badge-stage-label:render] status=uploading stageLabel=Extracting → expect text 'Extracting'");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(<LabStatusBadge status="uploading" stageLabel="Extracting" />);
    try {
      expect(container!.textContent).toBe("Extracting");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("extracting-stagelabel-assert-failed", container);
      throw err;
    }
  });

  it("format running with stageLabel='Transcoding 360p' → badge text is 'Transcoding 360p'", async () => {
    console.info("[lab-status-badge-stage-label:render] status=transcoding stageLabel='Transcoding 360p' → expect literal text");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(
      <LabStatusBadge status="transcoding" stageLabel="Transcoding 360p" />,
    );
    try {
      expect(container!.textContent).toBe("Transcoding 360p");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("transcoding-stagelabel-assert-failed", container);
      throw err;
    }
  });

  it("uploading with no stageLabel → falls back to localized 'Uploading'", async () => {
    console.info("[lab-status-badge-stage-label:render] status=uploading no stageLabel → expect fallback 'Uploading'");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(<LabStatusBadge status="uploading" />);
    try {
      expect(container!.textContent).toBe("Uploading");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("no-stagelabel-fallback-assert-failed", container);
      throw err;
    }
  });

  it("uploading with stageLabel='uploading' (case-insensitive match) → falls back (no echo of status word)", async () => {
    console.info("[lab-status-badge-stage-label:render] status=uploading stageLabel='uploading' → expect fallback (no echo)");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(<LabStatusBadge status="uploading" stageLabel="uploading" />);
    try {
      expect(container!.textContent).toBe("Uploading");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("case-match-fallback-assert-failed", container);
      throw err;
    }
  });

  it("terminal status='done' ignores stageLabel and renders 'Done'", async () => {
    console.info("[lab-status-badge-stage-label:render] status=done stageLabel=Extracting → expect terminal ignores stageLabel → 'Done'");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(<LabStatusBadge status="done" stageLabel="Extracting" />);
    try {
      expect(container!.textContent).toBe("Done");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("terminal-ignores-stagelabel-assert-failed", container);
      throw err;
    }
  });

  it("badge color is still tied to status (not stageLabel) — uploading keeps cyan classes", async () => {
    console.info("[lab-status-badge-stage-label:render] status=uploading stageLabel=Extracting → expect cyan color classes (color tied to status)");
    const { LabStatusBadge } = await import(
      "../src/renderer/src/components/LabStatusBadge"
    );
    await render(<LabStatusBadge status="uploading" stageLabel="Extracting" />);
    const span = container!.querySelector("span")!;
    try {
      expect(span.className).toContain("text-cyan-400");
      expect(span.className).toContain("bg-cyan-500/20");
    } catch (err) {
      dumpLabStatusBadgeSnapshot("color-tied-to-status-assert-failed", container);
      throw err;
    }
  });
});
