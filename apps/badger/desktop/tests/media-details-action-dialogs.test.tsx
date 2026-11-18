// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import MediaDetailsActionDialogs from "../src/renderer/src/components/MediaDetailsActionDialogs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Check: () => <span data-testid="check-icon" />,
  Loader2: () => <span data-testid="loader-icon" />,
  Plus: () => <span data-testid="plus-icon" />,
}));

const t = (key: string) => key;

// On assertion failure, dump the rendered button labels + the call counts of
// every callback under test so a routing regression is self-describing.
const dumpDialogsSnapshot = (
  label: string,
  ctx: {
    container: HTMLDivElement | null;
    callbacks?: Record<string, { mock: { calls: unknown[][] } }>;
  },
) => {
  try {
    const buttons = Array.from(ctx.container?.querySelectorAll("button") ?? []).map(
      (b) => b.textContent,
    );
    const iframeSrc = ctx.container?.querySelector("iframe")?.getAttribute("src") ?? null;
    console.error(`=== [media-details-action-dialogs:${label}] snapshot ===`);
    console.error(`rendered button labels=${JSON.stringify(buttons)}`);
    console.error(`iframe src=${JSON.stringify(iframeSrc)}`);
    if (ctx.callbacks) {
      const counts: Record<string, unknown[][]> = {};
      for (const [name, fn] of Object.entries(ctx.callbacks)) {
        counts[name] = fn.mock.calls;
      }
      console.error(`callback calls=${JSON.stringify(counts)}`);
    }
    console.error(`container.innerHTML=\n${ctx.container?.innerHTML ?? "(no container)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("MediaDetailsActionDialogs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = async (element: React.ReactNode) => {
    console.info("[media-details-action-dialogs:render] mounting dialogs into fresh container");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(element);
      await Promise.resolve();
    });
    const buttonCount = container?.querySelectorAll("button").length ?? 0;
    console.info(`[media-details-action-dialogs:render] mounted, button count=${buttonCount}`);
  };

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

  it("[@bugfix][@regression-proof] routes restore, delete, and playlist actions through the extracted media details dialogs", async () => {
    const onRestoreOpenChange = vi.fn();
    const onRestoreKeepCast = vi.fn();
    const onRestoreFull = vi.fn();
    const onDeleteTargetChange = vi.fn();
    const onConfirmDelete = vi.fn();
    const onShowPlaylistPickerChange = vi.fn();
    const onTogglePlaylist = vi.fn();

    await render(
      <MediaDetailsActionDialogs
        restoreOpen
        onRestoreOpenChange={onRestoreOpenChange}
        hasCustomCast
        restoring={false}
        onRestoreKeepCast={onRestoreKeepCast}
        onRestoreFull={onRestoreFull}
        activeTrailerKey={null}
        onActiveTrailerKeyChange={vi.fn()}
        buildTrailerUrl={(key) => `https://example.test/${key}`}
        deleteTarget={{ id: "media-1", title: "Better Call Saul" }}
        deletingMedia={false}
        onDeleteTargetChange={onDeleteTargetChange}
        onConfirmDelete={onConfirmDelete}
        showPlaylistPicker
        onShowPlaylistPickerChange={onShowPlaylistPickerChange}
        playlists={[
          { id: "playlist-1", name: "Watch later", slug: "watch-later", isSystem: false },
          { id: "favorites", name: "Favorites", slug: "favorites", isSystem: true },
        ]}
        selectedPlaylistIds={[]}
        playlistLabel={(name) => name}
        onTogglePlaylist={onTogglePlaylist}
        t={t}
      />
    );

    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    console.info(
      `[media-details-action-dialogs:click] clicking action buttons; available labels=${JSON.stringify(buttons.map((b) => b.textContent))}`,
    );
    buttons.find((button) => button.textContent === "library.edit.restoreKeepCast")?.click();
    buttons.find((button) => button.textContent === "library.edit.restoreFull")?.click();
    buttons.find((button) => button.textContent === "library.delete")?.click();
    buttons.find((button) => button.textContent?.includes("Watch later"))?.click();
    buttons.find((button) => button.textContent === "library.close")?.click();

    const callbacks = {
      onRestoreKeepCast,
      onRestoreFull,
      onConfirmDelete,
      onTogglePlaylist,
      onShowPlaylistPickerChange,
    };
    console.info(
      `[media-details-action-dialogs:assert] restoreKeepCast=${onRestoreKeepCast.mock.calls.length} restoreFull=${onRestoreFull.mock.calls.length} confirmDelete=${onConfirmDelete.mock.calls.length} togglePlaylist=${onTogglePlaylist.mock.calls.length} showPlaylistPickerChange=${onShowPlaylistPickerChange.mock.calls.length}`,
    );
    try {
      expect(onRestoreKeepCast).toHaveBeenCalledTimes(1);
      expect(onRestoreFull).toHaveBeenCalledTimes(1);
      expect(onConfirmDelete).toHaveBeenCalledTimes(1);
      expect(onTogglePlaylist).toHaveBeenCalledWith("playlist-1");
      expect(onShowPlaylistPickerChange).toHaveBeenCalledWith(false);
    } catch (err) {
      dumpDialogsSnapshot("action-routing", { container, callbacks });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] renders trailer playback through the extracted media details action dialogs", async () => {
    const onActiveTrailerKeyChange = vi.fn();

    await render(
      <MediaDetailsActionDialogs
        restoreOpen={false}
        onRestoreOpenChange={vi.fn()}
        hasCustomCast={false}
        restoring={false}
        onRestoreKeepCast={vi.fn()}
        onRestoreFull={vi.fn()}
        activeTrailerKey="abc123"
        onActiveTrailerKeyChange={onActiveTrailerKeyChange}
        buildTrailerUrl={(key) => `https://trailers.test/${key}`}
        deleteTarget={null}
        deletingMedia={false}
        onDeleteTargetChange={vi.fn()}
        onConfirmDelete={vi.fn()}
        showPlaylistPicker={false}
        onShowPlaylistPickerChange={vi.fn()}
        playlists={[]}
        selectedPlaylistIds={[]}
        playlistLabel={(name) => name}
        onTogglePlaylist={vi.fn()}
        t={t}
      />
    );

    const iframe = container?.querySelector("iframe");
    console.info(
      `[media-details-action-dialogs:assert-trailer] iframe present=${iframe !== null && iframe !== undefined} src=${JSON.stringify(iframe?.getAttribute("src"))}`,
    );
    try {
      expect(iframe?.getAttribute("src")).toBe("https://trailers.test/abc123");
    } catch (err) {
      dumpDialogsSnapshot("trailer-playback", { container });
      throw err;
    }
  });

  // @req UX-SKY-01[badger-desktop]
  it("marks the document as playing (<html data-app-playback>) only while a trailer plays, so no shooting star flies over it", async () => {
    const dialogs = (activeTrailerKey: string | null) => (
      <MediaDetailsActionDialogs
        restoreOpen={false}
        onRestoreOpenChange={vi.fn()}
        hasCustomCast={false}
        restoring={false}
        onRestoreKeepCast={vi.fn()}
        onRestoreFull={vi.fn()}
        activeTrailerKey={activeTrailerKey}
        onActiveTrailerKeyChange={vi.fn()}
        buildTrailerUrl={(key) => `https://trailers.test/${key}`}
        deleteTarget={null}
        deletingMedia={false}
        onDeleteTargetChange={vi.fn()}
        onConfirmDelete={vi.fn()}
        showPlaylistPicker={false}
        onShowPlaylistPickerChange={vi.fn()}
        playlists={[]}
        selectedPlaylistIds={[]}
        playlistLabel={(name) => name}
        onTogglePlaylist={vi.fn()}
        t={t}
      />
    );
    const marked = () => document.documentElement.hasAttribute("data-app-playback");

    await render(dialogs(null));
    const beforeTrailer = marked();
    await act(async () => {
      root?.render(dialogs("abc123"));
      await Promise.resolve();
    });
    const duringTrailer = marked();
    await act(async () => {
      root?.render(dialogs(null));
      await Promise.resolve();
    });
    const afterTrailer = marked();
    console.info(`[media-details-action-dialogs:playback-mark] before=${beforeTrailer} during=${duringTrailer} after=${afterTrailer}`);
    expect({ beforeTrailer, duringTrailer, afterTrailer }).toEqual({ beforeTrailer: false, duringTrailer: true, afterTrailer: false });
  });
});
