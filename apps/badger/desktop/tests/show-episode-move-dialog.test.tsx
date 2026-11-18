// @vitest-environment jsdom
/**
 * LIB-SHOW-04 (Chris 2026-11-04): when the catalog stops listing an episode the user
 * has a file for, the desktop suggests a change and says in plain words what a
 * "Yes" does before anything moves. One likely place: Yes / No. No likely
 * place, or a merged part: keep it as it is or pick its episode by hand. It
 * never offers deleting the file.
 */
// @req LIB-SHOW-04[badger-desktop]

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShowEpisodeMoveDialog from "../src/renderer/src/components/ShowEpisodeMoveDialog";
import type { ShowEpisodeMoveOffer } from "../src/renderer/src/lib/showRefresh";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[show-episode-move-dialog.test]";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const special3 = { id: "s0e3", seasonNumber: 0, episodeNumber: 3, title: "Christmas Party" };
const party: ShowEpisodeMoveOffer = {
  id: "s2e10",
  seasonNumber: 2,
  episodeNumber: 10,
  title: "Christmas Party",
  move: { kind: "move", target: special3 },
};
const merged = { id: "s1e5", seasonNumber: 1, episodeNumber: 5, title: "The Finale" };
const part1: ShowEpisodeMoveOffer = {
  id: "s1e5p1",
  seasonNumber: 1,
  episodeNumber: 5,
  title: "The Finale (1)",
  move: { kind: "merged", into: merged, partIds: ["s1e5p1", "s1e6p2"] },
};
const part2 = { id: "s1e6p2", seasonNumber: 1, episodeNumber: 6, title: "The Finale (2)" };

describe("ShowEpisodeMoveDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: Partial<React.ComponentProps<typeof ShowEpisodeMoveDialog>> = {}) => {
    const onMove = vi.fn();
    const onKeep = vi.fn();
    act(() => {
      root.render(
        <ShowEpisodeMoveDialog
          showTitle="The Office"
          episode={party}
          otherParts={[]}
          choices={[]}
          busy={false}
          onMove={onMove}
          onKeep={onKeep}
          {...props}
        />
      );
    });
    console.info(P, "rendered", container.textContent);
    return { onMove, onKeep };
  };

  const el = <T extends Element = HTMLElement>(testId: string) => container.querySelector<T & Element>(`[data-testid="${testId}"]`) as T | null;
  const text = () => container.textContent ?? "";

  it("@req LIB-SHOW-04[badger-desktop] names the new place and what moves with it before the user says yes", () => {
    const { onMove, onKeep } = render();
    const description = el("show-episode-move-description")?.textContent ?? "";
    console.info(P, "description", description);
    expect(description).toContain("library.showDelisting.moveSuggested");
    expect(description).toContain(`"show":"The Office"`);
    expect(description).toContain(`"episode":"S02E10 'Christmas Party'"`);
    expect(description).toContain(`library.showDelisting.special {\\"number\\":3}`);
    expect(text()).toContain("library.showDelisting.moveCarries");
    expect(onMove, "nothing moves before Yes").not.toHaveBeenCalled();
    act(() => el<HTMLButtonElement>("show-episode-move-keep")?.click());
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
    act(() => el<HTMLButtonElement>("show-episode-move-yes")?.click());
    expect(onMove).toHaveBeenCalledWith("s0e3");
    expect(el("show-episode-move-pick"), "no pick list when one place is likely").toBeNull();
  });

  it("@req LIB-SHOW-04[badger-desktop] never offers deleting the file", () => {
    for (const episode of [party, part1, { ...party, move: { kind: "none" as const } }]) {
      render({ episode, otherParts: episode === part1 ? [part2] : [] });
      const buttons = [...container.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
      console.info(P, "buttons", episode.move.kind, buttons);
      expect(buttons.some((id) => /remove|delete/i.test(id ?? ""))).toBe(false);
      expect(text()).not.toMatch(/remove|delete/i);
    }
  });

  it("@req LIB-SHOW-04[badger-desktop] says the catalog merged the parts and offers keep-or-pick-by-hand for each", () => {
    const { onMove, onKeep } = render({ episode: part1, otherParts: [part2], choices: [merged] });
    const description = el("show-episode-move-description")?.textContent ?? "";
    console.info(P, "merged description", description);
    expect(description).toContain("library.showDelisting.moveMerged");
    expect(description).toContain(`"parts":"S01E05 'The Finale (1)' + S01E06 'The Finale (2)'"`);
    expect(description).toContain(`"target":"S01E05 'The Finale'"`);
    expect(el("show-episode-move-yes"), "a merge is never moved as a whole").toBeNull();
    const picked = el<HTMLButtonElement>("show-episode-move-picked")!;
    expect(picked.disabled, "nothing to move until an episode is picked").toBe(true);

    const select = el<HTMLSelectElement>("show-episode-move-pick")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "s1e5");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picked.disabled).toBe(false);
    act(() => picked.click());
    expect(onMove).toHaveBeenCalledWith("s1e5");
    act(() => el<HTMLButtonElement>("show-episode-move-keep")?.click());
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("@req LIB-SHOW-04[badger-desktop] with no likely place offers keep or pick by hand, and says when nothing is free", () => {
    render({ episode: { ...party, move: { kind: "none" } }, choices: [] });
    expect(el("show-episode-move-description")?.textContent).toContain("library.showDelisting.moveNone");
    expect(el<HTMLSelectElement>("show-episode-move-pick")?.disabled).toBe(true);
    expect(text()).toContain("library.showDelisting.pickNone");
    expect(text()).toContain("library.showDelisting.keepAsIs");
  });

  it("@req LIB-SHOW-04[badger-desktop] disables both answers while the move runs", () => {
    render({ busy: true });
    expect(el<HTMLButtonElement>("show-episode-move-yes")?.disabled).toBe(true);
    expect(el<HTMLButtonElement>("show-episode-move-keep")?.disabled).toBe(true);
    expect(text()).toContain("library.showDelisting.moving");
  });
});
