/**
 * @test-id MOBILE-SHELL-SHORT-CODE-001
 * @level unit
 * @req ACCT-PAIR-01[badger-mobile,parrot,badger-tv]
 * @req UX-PHONE-10[badger-mobile,parrot]
 * @why Chris 2026-11-18: the pairing code has no dash anywhere. Phones and TVs show it as two groups of 4 boxes with a
 *   gap, and the code field takes it typed or pasted with or without a dash or spaces, in any case, each character
 *   landing in the next box by itself.
 */
import React, { useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  useWindowDimensions: () => ({ width: 411, height: 914 }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { surface: "#242638", border: "#44475a", text: "#dbdff0", accent: "#40dd8f" } }),
}));

import { ShortCodeInput, ShortCodeTiles } from "../src/short-code";

const TEST = "[short-code]";
const textOf = (node: ReactTestInstance) => node.children.filter((child) => typeof child === "string").join("");
const is = (name: string) => (n: ReactTestInstance) => (n.type as unknown) === name;
const groupsOf = (tree: ReactTestRenderer, testID: string) => {
  const code = tree.root.find((n) => n.props.testID === testID && is("View")(n));
  return (code.children as ReactTestInstance[]).map((group) => group.findAll(is("Text")).map(textOf).join(""));
};

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

describe("ShortCodeTiles", () => {
  // @bugfix @regression-proof Chris 2026-11-18: an older API's "ABCD-EFGH" still shows without a dash.
  it("shows the code as two groups of 4 boxes, never a dash", async () => {
    let tree!: ReactTestRenderer;
    for (const code of ["ABCDEFGH", "ABCD-EFGH"]) {
      await act(async () => {
        tree = create(<ShortCodeTiles code={code} testID="tiles" />);
      });
      console.info(TEST, "tiles", { code, groups: groupsOf(tree, "tiles") });
      expect(groupsOf(tree, "tiles")).toEqual(["ABCD", "EFGH"]);
      expect(tree.root.findAll(is("Text")).map(textOf)).not.toContain("-");
    }
  });
});

describe("ShortCodeInput", () => {
  const mount = async () => {
    const seen: string[] = [];
    const Field = () => {
      const [code, setCode] = useState("");
      return (
        <ShortCodeInput
          testID="field"
          value={code}
          onChange={(next) => {
            seen.push(next);
            setCode(next);
          }}
        />
      );
    };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Field />);
    });
    const input = () => tree.root.find((n) => is("TextInput")(n) && n.props.testID === "field");
    const type = async (raw: string) => {
      await act(async () => input().props.onChangeText(raw));
    };
    const boxes = () => tree.root.findAll(is("Text")).map(textOf);
    return { tree, input, type, boxes, seen };
  };

  // @bugfix @regression-proof Chris 2026-11-18: typed or pasted with or without a dash or spaces, in any case.
  it("keeps the plain 8 characters of a typed or pasted code", async () => {
    const field = await mount();
    for (const [raw, kept] of [
      ["7ryr-ebtw", "7RYREBTW"],
      ["ABCD EFGH", "ABCDEFGH"],
      ["k7m4\u2013qxr2", "K7M4QXR2"],
      ["https://spacefleet.io/pair/parrot?code=ABCD-EFGH", "ABCDEFGH"],
    ]) {
      await field.type(raw);
      console.info(TEST, "typed", { raw, value: field.input().props.value, boxes: field.boxes() });
      expect(field.input().props.value).toBe(kept);
      expect(field.boxes()).toEqual(kept.split(""));
    }
  });

  // @bugfix @regression-proof Chris 2026-11-18: each character lands in the next box by itself.
  it("puts each typed character in the next box and outlines the box the next one goes in", async () => {
    const field = await mount();
    await act(async () => field.input().props.onFocus());
    await field.type("k");
    await field.type("k7");
    console.info(TEST, "boxes", field.boxes());
    expect(field.boxes()).toEqual(["K", "7", "", "", "", "", "", ""]);
    expect(field.seen).toEqual(["K", "K7"]);
    const outlined = field.tree.root
      .findAll((n) => is("View")(n) && Array.isArray(n.props.style))
      .filter((n) => n.props.style.some((s: { borderWidth?: number } | undefined) => s?.borderWidth === 2));
    expect(outlined).toHaveLength(1);
    // The third box (index 2) is the one waiting for a character.
    expect(textOf(outlined[0]!.findByType("Text" as never))).toBe("");
  });
});
