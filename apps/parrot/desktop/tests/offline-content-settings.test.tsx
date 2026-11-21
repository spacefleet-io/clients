// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-OFFLINE-MANAGE-001
 * @level integration (real Settings section + shared list + real translator; `window.parrot` mocked)
 * @why Settings › Manage offline content (OFFL-MANAGE-01): Parrot desktop lists what is kept on this computer (albums,
 *   playlists, songs) with each item's size and the total, where a song held by two kept items counts once; the bin on
 *   a row removes that item from this computer, "Remove all" asks first and then removes every kept item one by one
 *   (never the sign-out clear), a failed remove says so, and nothing kept shows the empty line.
 * @covers apps/parrot/desktop/src/renderer/src/OfflineContent.tsx
 * @req OFFL-MANAGE-01[parrot]
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLocalizedStorage } from "@space/shared/format";
import type { KeptKind, KeptStatus } from "@space/parrot-core";
import type { ParrotKeptSizes } from "../src/shared/ipc";
import { OfflineContent, type DescribeKept } from "../src/renderer/src/OfflineContent";
import { translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-OFFLINE-MANAGE-001]";
const log = (line: string) => console.log(`${SUITE} ${line}`);
const dump = (label: string, value: unknown) => console.log(`${SUITE} ${label}: ${JSON.stringify(value, null, 1)}`);

const MB = 1_000_000;
const t = translator("en");
const describeKept: DescribeKept = (kind, id) => {
  const names: Record<string, { title: string; subtitle?: string; imagePath?: string | null }> = {
    "album:alb-1": { title: "First Light", subtitle: "Test Band", imagePath: null },
    "playlist:pl-1": { title: "Road Trip" },
    "song:t9": { title: "Gale", subtitle: "Other Band" },
  };
  return names[`${kind}:${id}`] ?? null;
};

describe("Parrot desktop: Settings › Manage offline content", () => {
  let container: HTMLDivElement;
  let root: Root;
  let sizes: ParrotKeptSizes;
  let unkeepCalls: Array<[KeptKind, string]>;
  let failUnkeep: boolean;
  let pushKept: ((status: KeptStatus) => void) | null;

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = async (element: HTMLElement | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => element!.click());
    await flush();
  };
  const rowsNow = () => q("offline-content-row").map((row) => ({ key: row.dataset.rowKey, name: row.querySelector('[data-testid="offline-content-name"]')?.textContent, size: row.querySelector('[data-testid="offline-content-size"]')?.textContent }));
  const mount = async () => {
    await act(async () => root.render(<OfflineContent t={t} language="en" describe={describeKept} />));
    await flush();
  };

  beforeEach(() => {
    sizes = {
      entries: [
        { kind: "song", id: "t9", fileIds: ["f9"] },
        { kind: "playlist", id: "pl-1", fileIds: ["f1", "f9"] },
        { kind: "album", id: "alb-1", fileIds: ["f1", "f2"] },
      ],
      bytes: { f1: 4 * MB, f2: 5 * MB, f9: 3 * MB },
    };
    unkeepCalls = [];
    failUnkeep = false;
    pushKept = null;
    (window as unknown as { parrot: unknown }).parrot = {
      getKeptSizes: vi.fn(async () => sizes),
      unkeep: vi.fn(async (kind: KeptKind, id: string) => {
        unkeepCalls.push([kind, id]);
        if (failUnkeep) throw new Error("disk is busy");
        sizes = { ...sizes, entries: sizes.entries.filter((entry) => !(entry.kind === kind && entry.id === id)) };
        pushKept?.({ entries: [], songs: [], downloading: false });
        return { entries: [], songs: [], downloading: false };
      }),
      onKept: (listener: (status: KeptStatus) => void) => {
        pushKept = listener;
        return () => (pushKept = null);
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("lists albums, playlists and songs with their size, and a shared song counts once in the total", async () => {
    log("phase=mount");
    await mount();
    const rows = rowsNow();
    const total = q("offline-content-total")[0]?.textContent;
    dump("rows", rows);
    dump("total", total);
    expect(rows).toEqual([
      { key: "album:alb-1", name: "First Light", size: formatLocalizedStorage(9 * MB, "en") },
      { key: "playlist:pl-1", name: "Road Trip", size: formatLocalizedStorage(7 * MB, "en") },
      { key: "song:t9", name: "Gale", size: formatLocalizedStorage(3 * MB, "en") },
    ]);
    expect(total).toBe(formatLocalizedStorage(12 * MB, "en"));
  });

  it("removes one item from this computer, and the list reads again", async () => {
    await mount();
    log("phase=remove playlist");
    await click(q("offline-content-remove")[1]);
    dump("unkeep calls", unkeepCalls);
    dump("rows after", rowsNow());
    expect(unkeepCalls).toEqual([["playlist", "pl-1"]]);
    expect(rowsNow().map((row) => row.key)).toEqual(["album:alb-1", "song:t9"]);
    expect(q("offline-content-total")[0]?.textContent).toBe(formatLocalizedStorage(12 * MB, "en"));
  });

  it("asks before Remove all; cancel keeps everything, confirm removes each kept item", async () => {
    await mount();
    log("phase=remove all, cancel");
    await click(q("offline-content-remove-all")[0]);
    expect(q("offline-content-confirm").length).toBe(1);
    await click(q("offline-content-confirm-cancel")[0]);
    expect(unkeepCalls).toEqual([]);
    log("phase=remove all, confirm");
    await click(q("offline-content-remove-all")[0]);
    await click(q("offline-content-confirm-remove")[0]);
    dump("unkeep calls", unkeepCalls);
    expect(unkeepCalls).toEqual([
      ["album", "alb-1"],
      ["playlist", "pl-1"],
      ["song", "t9"],
    ]);
    expect(q("offline-content-empty")[0]?.textContent).toBe(t("offline.empty"));
  });

  it("says so when a remove fails, and shows the empty line when nothing is kept", async () => {
    failUnkeep = true;
    await mount();
    log("phase=failing remove");
    await click(q("offline-content-remove")[0]);
    const alert = q("offline-content-error")[0]?.textContent;
    dump("alert", alert);
    expect(alert).toBe(t("offline.removeFailed"));
    expect(rowsNow().length).toBe(3);
    log("phase=empty");
    sizes = { entries: [], bytes: {} };
    await act(async () => pushKept?.({ entries: [], songs: [], downloading: false }));
    await flush();
    expect(q("offline-content-empty")[0]?.textContent).toBe(t("offline.empty"));
    expect(q("offline-content-total")[0]?.textContent).toBe(formatLocalizedStorage(0, "en"));
  });
});
