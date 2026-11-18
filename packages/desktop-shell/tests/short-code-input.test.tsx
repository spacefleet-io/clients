/**
 * @vitest-environment jsdom
 *
 * @test-id DESKTOP-SHELL-SHORT-CODE-INPUT-001
 * @level unit
 * @req ACCT-PAIR-01[badger-desktop,parrot]
 * @why Chris 2026-11-18: the pairing code has no dash anywhere. The code field on a computer shows 8 boxes in two
 *   groups of 4, takes the code typed or pasted with or without a dash or spaces, in any case, and puts each
 *   character in the next box by itself.
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShortCodeInput } from "../src/components/short-code-input";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEST = "[short-code-input]";

const Field = ({ seen }: { seen: string[] }) => {
  const [code, setCode] = useState("");
  return (
    <ShortCodeInput
      testId="code"
      value={code}
      onChange={(next) => {
        seen.push(next);
        setCode(next);
      }}
    />
  );
};

describe("ShortCodeInput (desktop)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: string[];

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seen = [];
    await act(async () => root.render(<Field seen={seen} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const input = () => container.querySelector<HTMLInputElement>('[data-testid="code"]')!;
  const boxes = () => [...container.querySelectorAll('[data-testid="code-boxes"] span')].map((box) => box.textContent);
  const groups = () => [...container.querySelectorAll('[data-testid="code-boxes"] > div')].map((group) => group.textContent);

  const typeValue = async (value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const paste = async (text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    event.clipboardData = { getData: () => text };
    await act(async () => {
      input().dispatchEvent(event);
    });
  };

  // @bugfix @regression-proof Chris 2026-11-18: a code typed with its old dash, in lower case, or with spaces.
  it("keeps the plain 8 characters of a typed code, with or without a dash or spaces, in any case", async () => {
    for (const [raw, kept] of [
      ["abcd-efgh", "ABCDEFGH"],
      ["ABCD EFGH", "ABCDEFGH"],
      ["7ryr–ebtw", "7RYREBTW"],
      [" k7m4 qxr2 ", "K7M4QXR2"],
    ]) {
      await typeValue(raw);
      console.info(TEST, "typed", { raw, value: input().value, groups: groups() });
      expect(input().value).toBe(kept);
      expect(groups()).toEqual([kept.slice(0, 4), kept.slice(4)]);
    }
  });

  // @bugfix @regression-proof Chris 2026-11-18: each character lands in the next box by itself.
  it("puts each typed character in the next box", async () => {
    await typeValue("k");
    await typeValue("k7");
    await typeValue("k7m");
    console.info(TEST, "boxes", boxes());
    expect(boxes()).toEqual(["K", "7", "M", "", "", "", "", ""]);
    expect(seen).toEqual(["K", "K7", "K7M"]);
  });

  // @bugfix @regression-proof Chris 2026-11-18: a pasted code or pairing link fills every box, even over a full field.
  it("fills the boxes from a pasted code or pairing link", async () => {
    await paste("abcd-efgh");
    expect(input().value).toBe("ABCDEFGH");
    await paste("https://spacefleet.io/pair/badger?code=7RYR-EBTW");
    console.info(TEST, "pasted", { value: input().value, groups: groups() });
    expect(input().value).toBe("7RYREBTW");
    expect(groups()).toEqual(["7RYR", "EBTW"]);
    expect(container.textContent).not.toContain("-");
  });
});
