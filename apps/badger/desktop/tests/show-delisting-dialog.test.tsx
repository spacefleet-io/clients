// @vitest-environment jsdom
/**
 * LIB-SHOW-02 (Chris 2026-10-29): when TMDB stops listing episodes the user
 * already has, the desktop asks before changing the library. The dialog lists
 * the episodes, says episodes with a file are never offered, and only removes
 * on an explicit click.
 */
// @req LIB-SHOW-02[badger-desktop]

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShowDelistingDialog from "../src/renderer/src/components/ShowDelistingDialog";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[show-delisting-dialog.test]";

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
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const episodes = [
  { id: "e1", seasonNumber: 1, episodeNumber: 8, title: "The Lost One" },
  { id: "e2", seasonNumber: 2, episodeNumber: 10, title: "" },
];

describe("ShowDelistingDialog", () => {
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

  const render = (props: Partial<React.ComponentProps<typeof ShowDelistingDialog>> = {}) => {
    const onRemove = vi.fn();
    const onKeep = vi.fn();
    act(() => {
      root.render(
        <ShowDelistingDialog showTitle="Severance" episodes={episodes} busy={false} onRemove={onRemove} onKeep={onKeep} {...props} />
      );
    });
    console.info(P, "rendered", container.textContent);
    return { onRemove, onKeep };
  };

  const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  it("@req LIB-SHOW-02[badger-desktop] lists the episodes TMDB dropped and says episodes with a file are never offered", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("library.showDelisting.title");
    expect(text).toContain('"show":"Severance"');
    expect(text).toContain("S01E08 · The Lost One");
    expect(text).toContain("S02E10");
    expect(text).not.toContain("S02E10 ·");
    expect(text).toContain("library.showDelisting.filesNote");
  });

  it("@req LIB-SHOW-02[badger-desktop] removes only on the Remove click, keeps on Keep", () => {
    const { onRemove, onKeep } = render();
    expect(onRemove).not.toHaveBeenCalled();
    act(() => button("show-delisting-keep")?.click());
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    act(() => button("show-delisting-remove")?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("@req LIB-SHOW-02[badger-desktop] disables both answers while the removal runs", () => {
    render({ busy: true });
    console.info(P, "busy", button("show-delisting-remove")?.disabled, button("show-delisting-keep")?.disabled);
    expect(button("show-delisting-remove")?.disabled).toBe(true);
    expect(button("show-delisting-keep")?.disabled).toBe(true);
    expect(container.textContent).toContain("library.showDelisting.removing");
  });
});
