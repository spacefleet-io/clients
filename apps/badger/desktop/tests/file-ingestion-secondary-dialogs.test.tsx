// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import FileIngestionTrailerDialogs from "../src/renderer/src/components/FileIngestionTrailerDialogs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("lucide-react", () => ({
  Check: () => <span data-testid="check-icon" />,
  Loader2: () => <span data-testid="loader-icon" />,
  // The shared ArtworkImage's fallback icons (UX-WAIT-03).
  Film: () => <span data-testid="film-icon" />,
  UserRound: () => <span data-testid="person-icon" />,
}));

vi.mock("../src/renderer/src/components/MediaImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt ?? ""} />,
}));

const t = (key: string) => key;

describe("file ingestion secondary dialogs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = async (element: React.ReactNode) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(element);
      await Promise.resolve();
    });
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

  // On assertion failure, dump the rendered dialog DOM (buttons, text,
  // iframe src) so a failed button-routing assertion is diagnosable offline.
  const dumpDialogsSnapshot = (label: string, mocks: Record<string, ReturnType<typeof vi.fn>>) => {
    try {
      console.error(`=== [file-ingestion-secondary-dialogs:${label}] snapshot ===`);
      const buttons = Array.from(container?.querySelectorAll("button") ?? []).map((b) => b.textContent);
      console.error(`rendered buttons (count=${buttons.length}): ${JSON.stringify(buttons)}`);
      const iframe = container?.querySelector("iframe");
      if (iframe) console.error(`iframe src=${iframe.getAttribute("src")}`);
      for (const [name, m] of Object.entries(mocks)) {
        console.error(`${name} calls=${JSON.stringify(m.mock.calls)}`);
      }
      console.error(`container.textContent: ${container?.textContent ?? "(no container)"}`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  it("[@bugfix][@regression-proof] routes add and skip actions through the extracted video resolve dialog", async () => {
    const onBack = vi.fn();
    const onSkip = vi.fn();
    const onAdd = vi.fn();
    const { default: FileIngestionResolveVideoDialog } = await import(
      "../src/renderer/src/components/FileIngestionResolveVideoDialog"
    );

    await render(
      <FileIngestionResolveVideoDialog
        open
        language="en"
        onOpenChange={vi.fn()}
        activeItem={{
          title: "Better Call Saul",
          slotLabel: "S01E03",
          quality: "360p",
          estimatedSizeMb: 123,
          existingQualities: ["1080p"],
        }}
        resolveIndex={1}
        totalCount={3}
        onBack={onBack}
        onSkip={onSkip}
        onAdd={onAdd}
        t={t}
      />
    );

    console.info(`[file-ingestion-secondary-dialogs:render] resolve-video dialog rendered; clicking back/skip/add`);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    buttons.find((button) => button.textContent === "ingestion.ui.back")?.click();
    buttons.find((button) => button.textContent === "ingestion.ui.skipQuality")?.click();
    buttons.find((button) => button.textContent === "ingestion.ui.addQuality")?.click();
    console.info(`[file-ingestion-secondary-dialogs:click] onBack=${onBack.mock.calls.length} onSkip=${onSkip.mock.calls.length} onAdd=${onAdd.mock.calls.length}`);

    try {
      expect(container?.textContent).toContain("Better Call Saul");
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpDialogsSnapshot("resolve-video-routing-assert", { onBack, onSkip, onAdd });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] routes dummy ingest search, type changes, and selection through the extracted dialog", async () => {
    const onTypeChange = vi.fn();
    const onQueryChange = vi.fn();
    const onSearch = vi.fn();
    const onSelect = vi.fn();
    const { default: FileIngestionDummyDialog } = await import(
      "../src/renderer/src/components/FileIngestionDummyDialog"
    );

    await render(
      <FileIngestionDummyDialog
        open
        onOpenChange={vi.fn()}
        ingestType="movie"
        onIngestTypeChange={onTypeChange}
        query="better"
        onQueryChange={onQueryChange}
        loading={false}
        error={null}
        results={[
          {
            id: 1,
            title: "Better Call Saul",
            type: "tv",
            year: 2015,
            posterPath: "/poster.jpg",
          } as any,
        ]}
        running={false}
        onSearch={onSearch}
        onSelect={onSelect}
        t={t}
      />
    );

    console.info(`[file-ingestion-secondary-dialogs:render] dummy dialog rendered; clicking tv/search/select`);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    buttons.find((button) => button.textContent === "ingestion.ui.tv")?.click();
    const input = container?.querySelector("input");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    buttons.find((button) => button.textContent === "ingestion.ui.search")?.click();
    buttons.find((button) => button.textContent?.includes("Better Call Saul"))?.click();
    console.info(`[file-ingestion-secondary-dialogs:click] onTypeChange=${JSON.stringify(onTypeChange.mock.calls)} onSearch=${onSearch.mock.calls.length} onSelect=${onSelect.mock.calls.length}`);

    try {
      expect(onTypeChange).toHaveBeenCalledWith("tv");
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 1, title: "Better Call Saul" }));
    } catch (err) {
      dumpDialogsSnapshot("dummy-dialog-routing-assert", { onTypeChange, onQueryChange, onSearch, onSelect });
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] renders trailer selection and playback through the extracted trailer dialogs", async () => {
    const onActiveTrailerKeyChange = vi.fn();
    const onOpenTrailerIdChange = vi.fn();
    const onSelectTrailer = vi.fn();

    await render(
      <FileIngestionTrailerDialogs
        activeTrailerKey="abc123"
        onActiveTrailerKeyChange={onActiveTrailerKeyChange}
        openTrailerId="tv:1"
        onOpenTrailerIdChange={onOpenTrailerIdChange}
        trailerCache={{
          "tv:1": {
            status: "ready",
            trailers: [
              {
                key: "abc123",
                language: "en",
                name: "Official Trailer",
                official: true,
              } as any,
            ],
          },
        }}
        buildTrailerUrl={(key) => `https://example.test/${key}`}
        onSelectTrailer={onSelectTrailer}
        t={t}
      />
    );

    console.info(`[file-ingestion-secondary-dialogs:render] trailer dialogs rendered; checking iframe src + clicking trailer`);
    const iframe = container?.querySelector("iframe");
    try {
      expect(iframe?.getAttribute("src")).toBe("https://example.test/abc123");
    } catch (err) {
      dumpDialogsSnapshot("trailer-iframe-src-assert", { onSelectTrailer });
      throw err;
    }

    const trailerButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Official Trailer")
    );
    trailerButton?.click();
    console.info(`[file-ingestion-secondary-dialogs:click] onSelectTrailer=${JSON.stringify(onSelectTrailer.mock.calls)}`);

    try {
      expect(onSelectTrailer).toHaveBeenCalledWith("abc123");
    } catch (err) {
      dumpDialogsSnapshot("trailer-select-assert", { onSelectTrailer });
      throw err;
    }
  });

  // @req UX-SKY-01[badger-desktop]
  it("marks the document as playing (<html data-app-playback>) while the ingestion trailer plays, and clears it on close", async () => {
    const dialogs = (activeTrailerKey: string | null) => (
      <FileIngestionTrailerDialogs
        activeTrailerKey={activeTrailerKey}
        onActiveTrailerKeyChange={vi.fn()}
        openTrailerId={null}
        onOpenTrailerIdChange={vi.fn()}
        trailerCache={{}}
        buildTrailerUrl={(key) => `https://example.test/${key}`}
        onSelectTrailer={vi.fn()}
        t={t}
      />
    );
    const marked = () => document.documentElement.hasAttribute("data-app-playback");

    await render(dialogs("abc123"));
    const duringTrailer = marked();
    await act(async () => {
      root?.render(dialogs(null));
      await Promise.resolve();
    });
    const afterTrailer = marked();
    console.info(`[file-ingestion-secondary-dialogs:playback-mark] during=${duringTrailer} after=${afterTrailer}`);
    expect({ duringTrailer, afterTrailer }).toEqual({ duringTrailer: true, afterTrailer: false });
  });
});
