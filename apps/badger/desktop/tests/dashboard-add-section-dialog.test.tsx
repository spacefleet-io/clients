// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

// On assertion failure, dump enough renderer state to diagnose offline:
// the dialog's rendered text, available buttons, and every section-callback's
// recorded call args. Wrapped in try/catch so a dump failure can't mask the
// real assertion failure.
const dumpDashboardAddSectionDialogSnapshot = (
  label: string,
  ctx: {
    container: HTMLElement | null;
    onOpenChange?: ReturnType<typeof vi.fn>;
    onAddSystemSection?: ReturnType<typeof vi.fn>;
    onAddGenreSection?: ReturnType<typeof vi.fn>;
    onAddPlaylistSection?: ReturnType<typeof vi.fn>;
  },
) => {
  try {
    const c = ctx.container;
    const input = c?.querySelector("input");
    const buttons = c
      ? Array.from(c.querySelectorAll("button")).map((b) => b.textContent ?? "")
      : [];
    console.error(`=== [dashboard-add-section-dialog:${label}] snapshot ===`);
    console.error(`input placeholder=${JSON.stringify(input?.getAttribute("placeholder") ?? null)}`);
    console.error(`buttons (${buttons.length})=${JSON.stringify(buttons)}`);
    console.error(
      `mock calls: onAddSystemSection=${JSON.stringify(ctx.onAddSystemSection?.mock.calls ?? [])} ` +
        `onAddGenreSection=${JSON.stringify(ctx.onAddGenreSection?.mock.calls ?? [])} ` +
        `onAddPlaylistSection=${JSON.stringify(ctx.onAddPlaylistSection?.mock.calls ?? [])} ` +
        `onOpenChange.calls=${ctx.onOpenChange?.mock.calls.length ?? 0}`,
    );
    console.error(`container.textContent=${JSON.stringify(c?.textContent ?? null)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("DashboardAddSectionDialog", () => {
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

  it("@bugfix @regression-proof routes system, genre, and playlist picks through the extracted dialog", async () => {
    const onOpenChange = vi.fn();
    const onAddSystemSection = vi.fn();
    const onAddGenreSection = vi.fn();
    const onAddPlaylistSection = vi.fn();

    console.info("[dashboard-add-section-dialog:setup] importing DashboardAddSectionDialog");
    const { default: DashboardAddSectionDialog } = await import(
      "../src/renderer/src/pages/DashboardAddSectionDialog"
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    console.info("[dashboard-add-section-dialog:render] mounting dialog (open) with 1 movie + 1 tv genre + 1 playlist");
    await act(async () => {
      root?.render(
        <DashboardAddSectionDialog
          open
          onOpenChange={onOpenChange}
          query=""
          onQueryChange={vi.fn()}
          matchesQuery={() => true}
          onAddSystemSection={onAddSystemSection}
          movieGenreOptions={[
            {
              key: "movie:18",
              id: 18,
              name: "Drama",
              Icon: ({ className }: { className?: string }) => <span className={className}>M</span>,
            },
          ]}
          tvGenreOptions={[
            {
              key: "tv:18",
              id: 18,
              name: "Drama TV",
              Icon: ({ className }: { className?: string }) => <span className={className}>T</span>,
            },
          ]}
          onAddGenreSection={onAddGenreSection}
          playlists={[{ id: "playlist-1", name: "Drama Picks" }]}
          onAddPlaylistSection={onAddPlaylistSection}
        />
      );
      await Promise.resolve();
    });

    const input = container.querySelector("input");
    if (input?.getAttribute("placeholder") !== "dashboard.edit.search") {
      dumpDashboardAddSectionDialogSnapshot("after-mount-placeholder-mismatch", {
        container,
        onOpenChange,
        onAddSystemSection,
        onAddGenreSection,
        onAddPlaylistSection,
      });
    }
    expect(input?.getAttribute("placeholder")).toBe("dashboard.edit.search");

    console.info("[dashboard-add-section-dialog:interact] clicking continue + Drama + Drama TV + Drama Picks buttons");
    const host = container;
    await act(async () => {
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("dashboard.sections.continue"))
        ?.click();
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Drama"))
        ?.click();
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Drama TV"))
        ?.click();
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Drama Picks"))
        ?.click();
      await Promise.resolve();
    });

    console.info("[dashboard-add-section-dialog:assert] verifying section callbacks fired with expected args");
    try {
      expect(input?.getAttribute("placeholder")).toBe("dashboard.edit.search");
      expect(onAddSystemSection).toHaveBeenCalledWith("continue");
      expect(onAddGenreSection).toHaveBeenCalledWith("movie", 18);
      expect(onAddGenreSection).toHaveBeenCalledWith("tv", 18);
      expect(onAddPlaylistSection).toHaveBeenCalledWith("playlist-1");
      expect(onOpenChange).not.toHaveBeenCalled();
    } catch (err) {
      dumpDashboardAddSectionDialogSnapshot("section-callback-assert-failed", {
        container,
        onOpenChange,
        onAddSystemSection,
        onAddGenreSection,
        onAddPlaylistSection,
      });
      throw err;
    }
  });
});
