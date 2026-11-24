// @vitest-environment jsdom
/**
 * @req PLAY-SKIP-09
 *
 * The show page's intro and credits times (Chris 2026-11-23/24, chat, skip UX, via Main): each episode row has a skip
 * button whose menu reads "Change intro times" when the episode has times and "Set intro times" when not; the panel
 * moves the handles with the arrow keys, Save asks "Use these times for" with the player's preselected answer, and
 * the save goes through the player's own write before "Saved for this season".
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaDetails, MediaSkipMarker } from "@space/shared/libraryTypes";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { applySkipEdit, preselectSkipEdit, toast } = vi.hoisted(() => ({
  applySkipEdit: vi.fn(async () => ({ kind: "saved", scope: "season" })),
  preselectSkipEdit: vi.fn(async () => ({
    kind: "preselect",
    scope: "season",
  })),
  toast: vi.fn(),
}));

vi.mock("@space/ui", () => {
  type DivProps = React.HTMLAttributes<HTMLDivElement> & {
    onEscapeKeyDown?: (event: React.KeyboardEvent) => void;
  };
  const Div = ({
    children,
    onEscapeKeyDown,
    onKeyDown,
    ...props
  }: DivProps) => (
    <div
      {...props}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscapeKeyDown?.(event);
        if (!event.defaultPrevented) onKeyDown?.(event);
      }}
    >
      {children}
    </div>
  );
  return {
    Button: ({
      children,
      variant: _v,
      size: _s,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
    }) => <button {...props}>{children}</button>,
    Dialog: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    DialogContent: Div,
    DialogDescription: Div,
    DialogFooter: Div,
    DialogHeader: Div,
    DialogTitle: Div,
    toast,
  };
});
vi.mock("lucide-react", () => ({ SkipForward: () => <span /> }));
vi.mock("@space/metadata-client", () => ({ queueSkipContribution: vi.fn() }));
vi.mock("../src/renderer/src/lib/mpvSkipEdit", () => ({
  applySkipEdit,
  preselectSkipEdit,
}));
vi.mock("../src/renderer/src/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { rendererLogger: logger };
});

import {
  SkipTimesMenu,
  type SkipTimesLibrary,
} from "../src/renderer/src/components/SkipTimesEditor";

const intro: MediaSkipMarker = {
  id: "m1",
  mediaId: "pr",
  episodeId: "e2",
  type: "intro",
  startSeconds: 70,
  endSeconds: 90,
  source: "detected",
  confidence: null,
  createdAt: "",
  updatedAt: "",
};

const mediaWith = (skipMarkers: MediaSkipMarker[]) =>
  ({
    id: "pr",
    title: "Parks and Recreation",
    episodes: [{ id: "e2", seasonNumber: 2, episodeNumber: 2 }],
    files: [{ id: "f2", season: 2, episode: 2 }],
    formats: [
      {
        fileId: "f2",
        isSource: true,
        durationSeconds: 1290,
        previewSheets: null,
      },
    ],
    skipMarkers,
  }) as unknown as MediaDetails;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const render = async (media: MediaDetails, lng: "en" | "fr" = "en") => {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
  const library: SkipTimesLibrary = {
    listSkipAnalysis: vi.fn(async () => []),
    upsertSkipAnalysis: vi.fn(async () => {}),
    replaceSkipMarkers: vi.fn(async () => {}),
    onChanged: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        <SkipTimesMenu
          media={media}
          episodeId="e2"
          episodeLine="Parks and Recreation · S2 E2"
          library={library}
          playbackToken={null}
        />
      </I18nextProvider>,
    ),
  );
  return library;
};

const byId = (id: string) => {
  const el = container!.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id} in:\n${container!.innerHTML}`);
  return el as HTMLElement;
};
const click = async (id: string) => act(async () => byId(id).click());
const key = async (id: string, k: string) =>
  act(async () => {
    byId(id).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  });
const handleLabel = (handle: "start" | "end") =>
  byId(`skip-times-handle-${handle}`).getAttribute("aria-label");

describe("show page skip times (PLAY-SKIP-09)", () => {
  it("@req PLAY-SKIP-09 offers Change intro times when the episode has times, Set times when not", async () => {
    await render(mediaWith([intro]));
    await click("skip-times-button-e2");
    expect(byId("skip-times-intro-e2").textContent).toBe("Change intro times");
    expect(byId("skip-times-credits-e2").textContent).toBe(
      en.library.skipTimes.setCredits,
    );
  });

  it("@req PLAY-SKIP-09 reads in French", async () => {
    await render(mediaWith([intro]), "fr");
    await click("skip-times-button-e2");
    expect(byId("skip-times-intro-e2").textContent).toBe(
      fr.player.skipUi.changeIntroTimes,
    );
    expect(byId("skip-times-credits-e2").textContent).toBe(
      fr.library.skipTimes.setCredits,
    );
  });

  it("@req PLAY-SKIP-09 nudges with the arrow keys, then saves for the preselected scope", async () => {
    const library = await render(mediaWith([intro]));
    await click("skip-times-button-e2");
    await click("skip-times-intro-e2");
    expect(handleLabel("start")).toContain("1:10");
    await key("skip-times-dialog", "ArrowRight");
    await key("skip-times-dialog", "ArrowRight");
    expect(handleLabel("start")).toContain("1:12");

    preselectSkipEdit.mockResolvedValueOnce({
      kind: "preselect",
      scope: "episode",
    });
    await click("skip-times-save");
    expect(preselectSkipEdit).toHaveBeenCalledWith(
      { action: "preselect", kind: "intro", startSeconds: 72, endSeconds: 90 },
      expect.anything(),
    );
    expect((byId("skip-times-scope-episode") as HTMLInputElement).checked).toBe(
      true,
    );

    // Esc goes back to the times, keeping them.
    await key("skip-times-dialog", "Escape");
    expect(handleLabel("start")).toContain("1:12");
    await click("skip-times-save");
    await click("skip-times-scope-season");
    await click("skip-times-scope-save");
    expect(applySkipEdit).toHaveBeenCalledWith(
      {
        action: "save",
        kind: "intro",
        startSeconds: 72,
        endSeconds: 90,
        scope: "season",
        durationSeconds: 1290,
      },
      expect.anything(),
    );
    expect(toast).toHaveBeenCalledWith("Saved for this season");
    expect(library.onChanged).toHaveBeenCalledTimes(1);
    expect(
      container!.querySelector('[data-testid="skip-times-dialog"]'),
    ).toBeNull();
  });

  it("@req PLAY-SKIP-09 sets new credits with one time that runs to the end", async () => {
    await render(mediaWith([]));
    await click("skip-times-button-e2");
    await click("skip-times-credits-e2");
    expect(
      container!.querySelector('[data-testid="skip-times-handle-end"]'),
    ).toBeNull();
    expect(handleLabel("start")).toContain("16:30");
    await click("skip-times-save");
    await click("skip-times-scope-save");
    expect(applySkipEdit).toHaveBeenCalledWith(
      {
        action: "save",
        kind: "credits",
        startSeconds: 990,
        endSeconds: 1290,
        scope: "season",
        durationSeconds: 1290,
      },
      expect.anything(),
    );
  });
});
