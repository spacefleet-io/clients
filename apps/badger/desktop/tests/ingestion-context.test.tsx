// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dialogSpy = vi.hoisted(() => vi.fn());

vi.mock("../src/renderer/src/components/FileIngestionDialog", () => ({
  default: (props: { open: boolean; paths: string[]; pathsNonce: number }) => {
    dialogSpy(props);
    return (
      <div data-testid="file-ingestion-dialog">
        {props.open ? "open" : "closed"}:{props.paths.join(",")}:{props.pathsNonce}
      </div>
    );
  },
}));

// Dump-on-failure helper: surfaces dialog mock call count/args + rendered DOM
// so a lazy-mount regression is diagnosable offline. try/catch-guarded.
const dumpIngestionSnapshot = (
  label: string,
  ctx: { container?: HTMLElement | null; dialogSpy?: ReturnType<typeof vi.fn> },
) => {
  try {
    console.error(`=== [ingestion-context:${label}] provider snapshot ===`);
    console.error(`dialogSpy.calls=${ctx.dialogSpy?.mock.calls.length ?? "n/a"}`);
    console.error(`dialogSpy.args=${JSON.stringify(ctx.dialogSpy?.mock.calls ?? null)}`);
    console.error(`container.textContent=${JSON.stringify(ctx.container?.textContent ?? null)}`);
    console.error(
      `dialog node present=${ctx.container ? ctx.container.querySelector("[data-testid='file-ingestion-dialog']") !== null : "n/a"}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("IngestionProvider", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    dialogSpy.mockReset();
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  it("[@bugfix][@regression-proof] does not mount the ingestion dialog until it is opened", async () => {
    const { IngestionProvider, useIngestion } = await import("../src/renderer/src/lib/ingestionContext");

    const Trigger = () => {
      const { openIngestion } = useIngestion();
      return (
        <button type="button" onClick={() => openIngestion(["/tmp/a.mkv"])}>
          open
        </button>
      );
    };

    console.info("[ingestion-context:setup] mounting IngestionProvider + Trigger");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <IngestionProvider>
          <Trigger />
        </IngestionProvider>
      );
      await Promise.resolve();
    });

    console.info(
      `[ingestion-context:assert] pre-open dialogSpy.calls=${dialogSpy.mock.calls.length} (expect 0)`,
    );
    if (dialogSpy.mock.calls.length !== 0 || container.querySelector("[data-testid='file-ingestion-dialog']") !== null) {
      dumpIngestionSnapshot("dialog-mounted-too-early", { container, dialogSpy });
    }
    expect(dialogSpy).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='file-ingestion-dialog']")).toBeNull();

    console.info("[ingestion-context:interact] clicking open trigger → openIngestion(['/tmp/a.mkv'])");
    const button = container.querySelector("button");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    console.info(
      `[ingestion-context:assert] post-open dialogSpy.calls=${dialogSpy.mock.calls.length} textContent=${JSON.stringify(container.textContent)}`,
    );
    if (dialogSpy.mock.calls.length === 0 || !container.textContent?.includes("open:/tmp/a.mkv:1")) {
      dumpIngestionSnapshot("dialog-not-opened", { container, dialogSpy });
    }
    expect(dialogSpy).toHaveBeenCalled();
    expect(container.textContent).toContain("open:/tmp/a.mkv:1");
  });
});
