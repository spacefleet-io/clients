// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.title ? `${key}:${String(params.title)}` : key,
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// Dump-on-failure helper: dumps rendered DOM text + mock call counts so a
// failed routing assertion is diagnosable offline. try/catch-guarded body.
const dumpDialogSnapshot = (
  label: string,
  ctx: { container?: HTMLElement | null; onClose?: ReturnType<typeof vi.fn>; onConfirm?: ReturnType<typeof vi.fn> },
) => {
  try {
    console.error(`=== [library-delete-dialog:${label}] dialog snapshot ===`);
    console.error(`container.textContent=${JSON.stringify(ctx.container?.textContent ?? null)}`);
    const buttons = ctx.container
      ? Array.from(ctx.container.querySelectorAll("button")).map((b) => b.textContent)
      : [];
    console.error(`buttons=${JSON.stringify(buttons)}`);
    console.error(
      `onClose.calls=${ctx.onClose?.mock.calls.length ?? "n/a"} onConfirm.calls=${ctx.onConfirm?.mock.calls.length ?? "n/a"}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("LibraryDeleteDialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
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

  it("@bugfix @regression-proof routes cancel and confirm through the extracted delete dialog", async () => {
    console.info("[library-delete-dialog:setup] creating spies + container");
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const { default: LibraryDeleteDialog } = await import("../src/renderer/src/pages/LibraryDeleteDialog");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    console.info("[library-delete-dialog:render] mounting dialog for media-1 'Better Call Saul'");
    await act(async () => {
      root?.render(
        <LibraryDeleteDialog
          deleteTarget={{ id: "media-1", title: "Better Call Saul" }}
          isDeleting={false}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );
      await Promise.resolve();
    });

    if (!(container.textContent ?? "").includes("library.deleteConfirm:Better Call Saul")) {
      dumpDialogSnapshot("confirm-text-missing", { container, onClose, onConfirm });
    }
    expect(container.textContent ?? "").toContain("library.deleteConfirm:Better Call Saul");

    console.info("[library-delete-dialog:interact] clicking cancel then delete buttons");
    const host = container;
    await act(async () => {
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("library.deleteCancel"))
        ?.click();
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "library.delete")
        ?.click();
      await Promise.resolve();
    });

    console.info(
      `[library-delete-dialog:assert] onClose.calls=${onClose.mock.calls.length} onConfirm.calls=${onConfirm.mock.calls.length}`,
    );
    if (onClose.mock.calls.length !== 1 || onConfirm.mock.calls.length !== 1) {
      dumpDialogSnapshot("callback-mismatch", { container, onClose, onConfirm });
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
