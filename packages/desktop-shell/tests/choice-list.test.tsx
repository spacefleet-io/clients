// @vitest-environment jsdom
/**
 * UX-SETUP-06: the setup language is a list that scrolls inside a fixed height (Chris 2026-11-09: "the language
 * selection should be a scrollable list, otherwise if we use a radio system it'll grow too long for the screen").
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceList, type ChoiceListOption } from "../src/components/choice-list";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: ChoiceListOption<string>[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "nl", label: "Nederlands" },
  { value: "de", label: "Deutsch" },
  { value: "da", label: "Dansk" },
];

describe("ChoiceList", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn();
  const scrolled: string[] = [];

  const Harness = ({ initial }: { initial: string }) => {
    const [value, setValue] = useState(initial);
    return (
      <ChoiceList
        name="language"
        value={value}
        options={OPTIONS}
        ariaLabel="Language"
        recommended="en"
        recommendedLabel="Recommended"
        onChange={(next) => {
          console.info(`[choice-list.test] picked ${next}`);
          onChange(next);
          setValue(next);
        }}
      />
    );
  };
  const list = () => host.querySelector<HTMLElement>('[role="listbox"]')!;
  const selected = () => host.querySelector('[aria-selected="true"]')?.getAttribute("data-testid");
  const key = async (k: string) => act(async () => list().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

  beforeEach(async () => {
    onChange.mockClear();
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-testid") ?? "");
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness initial="nl" />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("@req UX-SETUP-06 scrolls inside a fixed height and keeps the picked item in view", () => {
    expect(list().className).toContain("max-h-64");
    expect(list().className).toContain("overflow-y-auto");
    expect(list().getAttribute("aria-activedescendant")).toBe("choice-language-nl");
    expect(selected()).toBe("setup-language-nl");
    expect(scrolled).toContain("setup-language-nl");
    expect(host.textContent).toContain("Recommended");
  });

  it("@req UX-SETUP-06 @req UX-SETUP-08[badger-desktop,parrot] shows the 5 languages whole: 42 px rows in the 256 px list", () => {
    // Chris 2026-11-18: Español was cut off. py-2 rows (24 px line + 16 px padding + 2 px border) and their 8 px gaps
    // make 5 rows 250 px, inside max-h-64 (256 px), so the list does not scroll on either desktop.
    const rows = Array.from(list().querySelectorAll('[role="option"]'));
    console.info("[choice-list.test] rows", rows.length, rows[0]?.className);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.className).toContain("py-2 ");
      expect(row.className).not.toContain("py-3");
    }
  });

  it("@req UX-SETUP-06 moves with Up/Down and Home/End, and stops at the ends", async () => {
    await key("ArrowDown");
    expect(selected()).toBe("setup-language-de");
    await key("ArrowUp");
    await key("ArrowUp");
    expect(selected()).toBe("setup-language-fr");
    await key("End");
    expect(selected()).toBe("setup-language-da");
    await key("ArrowDown");
    // The last ArrowDown at the end changes nothing, so it calls nothing.
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["de", "nl", "fr", "da"]);
    await key("Home");
    expect(selected()).toBe("setup-language-en");
    expect(onChange).toHaveBeenLastCalledWith("en");
    expect(scrolled.at(-1)).toBe("setup-language-en");
  });

  it("@req UX-SETUP-06 jumps by first letter, cycling through matches, and picks on click", async () => {
    await key("d");
    expect(selected()).toBe("setup-language-de");
    await key("d");
    expect(selected()).toBe("setup-language-da");
    await act(async () => host.querySelector<HTMLElement>('[data-testid="setup-language-fr"]')!.click());
    expect(selected()).toBe("setup-language-fr");
    expect(onChange).toHaveBeenLastCalledWith("fr");
  });
});
