// @vitest-environment jsdom
/**
 * @test-id DESKTOP-TRAILER-DIALOG-ESCAPE-FOCUS-001
 * @level unit
 * @bugfix @regression-proof @req LIB-DETAIL-06
 * @why #2296 (Badger 0.1.2 macOS e2e, movie-playback:990): Escape sometimes left the trailer dialog open. Radix moves
 *      keyboard focus on open to the first tabbable element of the dialog, and in a trailer dialog that is the
 *      embedded player's iframe, so focus went into the embedded page and key presses were delivered there; Escape
 *      never reached the dialog's own handler on the app's document. Focus now stays on the dialog itself.
 * @covers apps/badger/desktop/src/renderer/src/lib/trailers.ts
 * @covers apps/badger/desktop/src/renderer/src/components/MediaDetailsActionDialogs.tsx
 * @covers apps/badger/desktop/src/renderer/src/components/FileIngestionTrailerDialogs.tsx
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import FileIngestionTrailerDialogs from "../src/renderer/src/components/FileIngestionTrailerDialogs";
import MediaDetailsActionDialogs from "../src/renderer/src/components/MediaDetailsActionDialogs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TAG = "[DESKTOP-TRAILER-DIALOG-ESCAPE-FOCUS-001]";
const t = (key: string) => key;
const buildTrailerUrl = (key: string) => `https://www.youtube-nocookie.com/embed/${key}`;
const noop = () => undefined;

function DetailTrailer({ onClosed }: { onClosed: () => void }) {
  const [key, setKey] = useState<string | null>("orchard-trailer");
  return (
    <MediaDetailsActionDialogs
      restoreOpen={false}
      onRestoreOpenChange={noop}
      hasCustomCast={false}
      restoring={false}
      onRestoreKeepCast={noop}
      onRestoreFull={noop}
      activeTrailerKey={key}
      onActiveTrailerKeyChange={(next) => {
        setKey(next);
        if (next === null) onClosed();
      }}
      buildTrailerUrl={buildTrailerUrl}
      deleteTarget={null}
      deletingMedia={false}
      onDeleteTargetChange={noop}
      onConfirmDelete={noop}
      showPlaylistPicker={false}
      onShowPlaylistPickerChange={noop}
      playlists={[]}
      selectedPlaylistIds={[]}
      playlistLabel={(name) => name}
      onTogglePlaylist={noop}
      t={t}
    />
  );
}

function IngestionTrailer({ onClosed }: { onClosed: () => void }) {
  const [key, setKey] = useState<string | null>("orchard-trailer");
  return (
    <FileIngestionTrailerDialogs
      activeTrailerKey={key}
      onActiveTrailerKeyChange={(next) => {
        setKey(next);
        if (next === null) onClosed();
      }}
      openTrailerId={null}
      onOpenTrailerIdChange={noop}
      trailerCache={{}}
      buildTrailerUrl={buildTrailerUrl}
      onSelectTrailer={noop}
      t={t}
    />
  );
}

const describeFocus = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return "(none)";
  return `${el.tagName} role=${el.getAttribute("role")} inDialog=${Boolean(el.closest('[role="dialog"]'))}`;
};

describe("trailer dialogs keep keyboard focus out of the embedded player", () => {
  let container: HTMLDivElement;
  let root: Root;

  // Main's `escapeKeyForward.ts` sends every Escape of the window over `sf-escape-key`; the preload exposes it here.
  const escapeListeners = new Set<() => void>();
  const escapeFromMain = async () => {
    await act(async () => {
      for (const listener of [...escapeListeners]) listener();
    });
  };

  beforeEach(() => {
    escapeListeners.clear();
    (window as unknown as { sf: unknown }).sf = {
      onEscapeKey: (callback: () => void) => {
        escapeListeners.add(callback);
        return () => escapeListeners.delete(callback);
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as unknown as { sf?: unknown }).sf;
  });

  const cases: Array<[string, (props: { onClosed: () => void }) => React.ReactElement]> = [
    ["media detail page trailer", (props) => <DetailTrailer {...props} />],
    ["file ingestion trailer", (props) => <IngestionTrailer {...props} />],
  ];

  for (const [name, make] of cases) {
    it(`${name}: focus is on the dialog, not the iframe, and Escape closes it once`, async () => {
      let closed = 0;
      await act(async () => root.render(make({ onClosed: () => (closed += 1) })));
      // Radix moves focus in a layout effect / microtask after mount.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const iframe = dialog?.querySelector("iframe") ?? null;
      console.info(`${TAG} ${name}: opened dialog=${Boolean(dialog)} iframe=${Boolean(iframe)} iframe.tabIndex=${iframe?.tabIndex} focus=${describeFocus()}`);
      expect(dialog, "trailer dialog rendered").toBeTruthy();
      expect(iframe, "trailer iframe rendered").toBeTruthy();
      expect(document.activeElement, `focus must not be the embedded player (focus=${describeFocus()})`).not.toBe(iframe);
      expect(dialog!.contains(document.activeElement), `focus stays inside the dialog (focus=${describeFocus()})`).toBe(true);

      // A key press goes to the focused element of the app's document; Escape must close the dialog from there.
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      // Main forwards the same key press: the trailer is already closed and must not be closed twice.
      await escapeFromMain();
      console.info(`${TAG} ${name}: after Escape closed=${closed} dialogs=${document.querySelectorAll('[role="dialog"]').length}`);
      expect(closed, "Escape closes the trailer exactly once").toBe(1);
    });

    it(`${name}: after a click into the player, the Escape main forwards closes the trailer`, async () => {
      let closed = 0;
      await act(async () => root.render(make({ onClosed: () => (closed += 1) })));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const iframe = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');
      expect(iframe, "trailer iframe rendered").toBeTruthy();

      // Clicking Play in the player moves focus into its frame; its key presses then never reach the app's document,
      // so only main's forwarded Escape arrives.
      await act(async () => iframe!.focus());
      console.info(`${TAG} ${name}: focus after the click into the player=${describeFocus()}`);
      expect(document.activeElement, "focus is in the player (the user clicked it)").toBe(iframe);
      await escapeFromMain();
      await escapeFromMain();
      console.info(`${TAG} ${name}: after forwarded Escape closed=${closed} dialogs=${document.querySelectorAll('[role="dialog"]').length}`);
      expect(closed, "the forwarded Escape closes the trailer, once").toBe(1);
    });
  }
});
