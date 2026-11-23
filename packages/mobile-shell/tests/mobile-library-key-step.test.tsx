/**
 * @test-id MOBILE-SHELL-LIBRARY-KEY-STEP-001
 * @level unit
 * @why Chris 2026-11-12 (chat): "the setup step to enter/save the key should be the same shared one between the 2
 *   apps". Badger phone and TV and Parrot phone now show one key step (`MobileLibraryKeyStep`, on the shared setup
 *   step: header with Back and the language, card, Back and the main button pinned at the bottom). The app hands it
 *   its key check, its "Get the key from another device" panel and its erase call. These tests pin what the step
 *   does with them: the 12 boxes or the 12 words, the other-device card that swaps in the panel and empties the
 *   boxes, Continue off until the key reads whole, the "Lost your key?" link (only where a key is typed and the app
 *   can erase) under which the note always says nobody can open the library without the key, and the erase dialog
 *   that erases through the app and stays open when that fails. The erase is the last resort (Chris 2026-11-12
 *   (chat): "The nuke is only needed when the user has access to no logged in session of any of the apps on any
 *   platform"): the dialog's other-device line closes it and opens the panel.
 * @req UX-KEY-01[badger-mobile,badger-tv,parrot]
 * @req ACCT-PAIR-01[badger-mobile,badger-tv,parrot]
 * @req UX-TV-17[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isTV: false }));
vi.mock("react-native", () => ({
  Platform: platform,
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/logger", () => ({
  scopeLogger: () => ({ info: (...args: unknown[]) => console.info("[MOBILE-SHELL-LIBRARY-KEY-STEP-001] log", ...args) }),
}));
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { text: "#fff", textMuted: "#999", danger: "#e00" } }) }));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The grid renders the action the step hands it (Generate a new key), so the tests can press it.
vi.mock("../src/libraryKeyWords", () => ({
  LibraryKeyWordsGrid: (props: { action?: React.ReactNode }) => React.createElement("LibraryKeyWordsGrid", props, props.action),
  LibraryKeyWordsInput: "LibraryKeyWordsInput",
}));
vi.mock("../src/components/mobile-button-face", () => ({ MobileButtonFace: "MobileButtonFace" }));
vi.mock("../src/components/mobile-phone-sign-in-card", () => ({ MobilePhoneSignInCard: "MobilePhoneSignInCard" }));
vi.mock("../src/components/mobile-erase-library-dialog", () => ({ MobileEraseLibraryDialog: "MobileEraseLibraryDialog" }));
// The setup step (its own tests) as a host element keeping its props, with the card and what comes after it inside.
vi.mock("../src/components/mobile-setup-step", () => ({
  MobileSetupStep: (props: { children?: React.ReactNode; afterCard?: React.ReactNode }) =>
    React.createElement("MobileSetupStep", props, props.children, props.afterCard),
}));

import { MobileLibraryKeyStep, type MobileLibraryKeyStepProps } from "../src/components/mobile-library-key-step";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-KEY-STEP-001]";
let tree: ReactTestRenderer | null = null;

const mount = (props: Partial<MobileLibraryKeyStepProps>) => {
  const all: MobileLibraryKeyStepProps = { mode: "enter", title: "Title", body: "Body", canContinue: false, onContinue: () => undefined, ...props };
  act(() => {
    tree = create(<MobileLibraryKeyStep {...all} />);
  });
  return tree!;
};
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n: ReactTestInstance) => (n.type as unknown) === type);
const byId = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((n: ReactTestInstance) => n.props.testID === id && typeof n.type === "string");
const step = (root: ReactTestRenderer) => byType(root, "MobileSetupStep")[0]!;
const dialog = (root: ReactTestRenderer) => byType(root, "MobileEraseLibraryDialog")[0];
const texts = (node: ReactTestInstance) =>
  node
    .findAll((n: ReactTestInstance) => (n.type as unknown) === "Text")
    .flatMap((n: ReactTestInstance) => n.children.filter((c: unknown): c is string => typeof c === "string"));

afterEach(() => {
  platform.isTV = false;
  act(() => tree?.unmount());
  tree = null;
});

describe("MobileLibraryKeyStep (MOBILE-SHELL-LIBRARY-KEY-STEP-001)", () => {
  it("show mode: the 12 words, Generate a new key, the app's label on the main button, the note, no link", () => {
    const onRegenerate = vi.fn();
    const words = Array.from({ length: 12 }, (_, i) => `w${i + 1}`);
    const root = mount({ mode: "show", words, onRegenerate, continueLabel: "I've written it down", canContinue: true });
    const props = step(root).props;
    console.info(SUITE, "show", JSON.stringify({ nextLabel: props.nextLabel, nextDisabled: props.nextDisabled, ids: ["key-lost-start-new-library", "key-lost-note"].map((id) => byId(root, id).length) }));
    expect(byType(root, "LibraryKeyWordsGrid")[0]!.props.words).toEqual(words);
    expect(byType(root, "LibraryKeyWordsInput")).toHaveLength(0);
    expect(props.nextLabel).toBe("I've written it down");
    expect(props.nextDisabled).toBe(false);
    act(() => byId(root, "key-regenerate")[0]!.props.onPress());
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(byId(root, "key-lost-start-new-library")).toHaveLength(0);
    expect(texts(byId(root, "key-lost-note")[0]!)).toEqual(["libraryKeyStep.lostKeyNote"]);
    expect(dialog(root)).toBeUndefined();
  });

  it("phone: the mascot, no box focused for the remote, the main button starts the remote in show mode only", () => {
    const show = mount({ mode: "show", words: Array.from({ length: 12 }, (_, i) => `w${i + 1}`), canContinue: true });
    console.info(SUITE, "phone show", JSON.stringify({ mascot: step(show).props.mascot, preferred: step(show).props.nextPreferredFocus }));
    expect(step(show).props.mascot).toBe(true);
    // A phone never asks for a preferred focus: a key event (hardware keyboard) would otherwise ring the main button.
    expect(step(show).props.nextPreferredFocus).toBe(false);
    act(() => tree?.unmount());
    const enter = mount({});
    expect(step(enter).props.nextPreferredFocus).toBe(false);
    expect(byType(enter, "LibraryKeyWordsInput")[0]!.props.autoFocus).toBe(false);
  });

  // @req UX-TV-33[badger-tv]
  it("TV: no mascot so the 12 words fit 1080p, the remote starts on I've written it down (show) or box 1 (enter)", () => {
    platform.isTV = true;
    const show = mount({ mode: "show", words: Array.from({ length: 12 }, (_, i) => `w${i + 1}`), canContinue: true, onRegenerate: () => undefined });
    const props = step(show).props;
    console.info(SUITE, "tv show", JSON.stringify({ mascot: props.mascot, preferred: props.nextPreferredFocus }));
    expect(props.mascot).toBe(false);
    expect(props.nextPreferredFocus).toBe(true);
    // UX-TV-33: no "Generate a new key" and nothing under the card on a TV's shown key; the words are to be written down.
    console.info(SUITE, "tv show extras", JSON.stringify({ action: byType(show, "LibraryKeyWordsGrid")[0]!.props.action ?? null, afterCard: props.afterCard ?? null }));
    expect(byType(show, "LibraryKeyWordsGrid")[0]!.props.action).toBeUndefined();
    expect(byId(show, "key-regenerate")).toHaveLength(0);
    expect(props.afterCard).toBeUndefined();
    expect(byId(show, "key-lost-note")).toHaveLength(0);
    act(() => tree?.unmount());
    const enter = mount({ onErase: async () => undefined });
    const link = byId(enter, "key-lost-start-new-library")[0]!;
    console.info(SUITE, "tv enter", JSON.stringify({ preferred: step(enter).props.nextPreferredFocus, autoFocus: byType(enter, "LibraryKeyWordsInput")[0]!.props.autoFocus }));
    expect(step(enter).props.nextPreferredFocus).toBe(false);
    expect(byType(enter, "LibraryKeyWordsInput")[0]!.props.autoFocus).toBe(true);
    expect(link.props.style[1].borderColor).toBe("transparent");
    act(() => link.props.onFocus());
    expect(byId(enter, "key-lost-start-new-library")[0]!.props.style[1].borderColor).toBe("#fff");
    // Typing a key keeps the line under the card on TV too.
    expect(byId(enter, "key-lost-note")).toHaveLength(1);
  });

  it("enter mode: the boxes, Continue (the shared label) off until the key reads whole, Enter in the boxes continues", () => {
    const onContinue = vi.fn();
    const onKeyChange = vi.fn();
    const off = mount({ onKeyChange, onContinue });
    expect(step(off).props.nextLabel).toBe("libraryKeyStep.continue");
    expect(step(off).props.nextDisabled).toBe(true);
    // Enter while the key is not whole does nothing.
    act(() => byType(off, "LibraryKeyWordsInput")[0]!.props.onSubmitEditing());
    expect(onContinue).not.toHaveBeenCalled();
    act(() => byType(off, "LibraryKeyWordsInput")[0]!.props.onChangeText("abc", { status: "incomplete" }));
    expect(onKeyChange).toHaveBeenCalledWith("abc", { status: "incomplete" });
    act(() => tree?.unmount());
    const on = mount({ onKeyChange, onContinue, canContinue: true, error: "Wrong key" });
    console.info(SUITE, "enter", JSON.stringify({ nextDisabled: step(on).props.nextDisabled, error: texts(byId(on, "key-error")[0]!) }));
    expect(step(on).props.nextDisabled).toBe(false);
    expect(step(on).props.onNext).toBe(onContinue);
    act(() => byType(on, "LibraryKeyWordsInput")[0]!.props.onSubmitEditing());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(texts(byId(on, "key-error")[0]!)).toEqual(["Wrong key"]);
  });

  it("the other-device card swaps in the app's panel, empties the boxes and hides the main button; Type the key instead comes back", () => {
    const onKeyChange = vi.fn();
    const root = mount({ onKeyChange, renderOtherDevice: () => <View testID="app-panel" /> });
    const card = byId(root, "key-from-another-device")[0]!;
    expect(card.props).toMatchObject({ title: "phonePairing.keyLink", body: "phonePairing.keyCard" });
    act(() => card.props.onPress());
    console.info(SUITE, "panel", JSON.stringify({ panel: byId(root, "key-other-device-panel").length, onNext: step(root).props.onNext ?? null, calls: onKeyChange.mock.calls }));
    expect(byId(root, "key-other-device-panel")).toHaveLength(1);
    expect(byId(root, "app-panel")).toHaveLength(1);
    expect(byType(root, "LibraryKeyWordsInput")).toHaveLength(0);
    expect(step(root).props.onNext).toBeUndefined();
    expect(onKeyChange).toHaveBeenLastCalledWith("", { status: "empty" });
    act(() => byId(root, "key-type-instead")[0]!.props.onPress());
    expect(byType(root, "LibraryKeyWordsInput")).toHaveLength(1);
    expect(onKeyChange).toHaveBeenCalledTimes(2);
  });

  it("no card when the app hands no panel; no link nor dialog when it cannot erase, the note still there", () => {
    const root = mount({});
    expect(byId(root, "key-from-another-device")).toHaveLength(0);
    expect(byId(root, "key-lost-start-new-library")).toHaveLength(0);
    expect(byId(root, "key-lost-note")).toHaveLength(1);
    expect(dialog(root)).toBeUndefined();
  });

  it("Lost your key? opens the erase dialog; a done erase closes it, a failed one rejects to the dialog and keeps it open", async () => {
    const failure = new Error("invalid_password");
    const onErase = vi.fn(async (password: string) => {
      if (password === "bad") throw failure;
    });
    const root = mount({ onErase });
    const link = byId(root, "key-lost-start-new-library")[0]!;
    expect(texts(link)).toEqual(["libraryKeyStep.lostKeyLink"]);
    expect(dialog(root)!.props.visible).toBe(false);
    act(() => link.props.onPress());
    expect(dialog(root)!.props.visible).toBe(true);

    let caught: unknown = null;
    await act(async () => {
      await dialog(root)!.props.onConfirm("bad").catch((err: unknown) => {
        caught = err;
      });
    });
    console.info(SUITE, "failed erase", String(caught), "visible", dialog(root)!.props.visible);
    expect(caught).toBe(failure);
    expect(dialog(root)!.props.visible).toBe(true);

    await act(async () => dialog(root)!.props.onConfirm("pw", "123456"));
    console.info(SUITE, "erase calls", JSON.stringify(onErase.mock.calls), "visible", dialog(root)!.props.visible);
    expect(onErase).toHaveBeenLastCalledWith("pw", "123456");
    expect(dialog(root)!.props.visible).toBe(false);

    act(() => byId(root, "key-lost-start-new-library")[0]!.props.onPress());
    act(() => dialog(root)!.props.onCancel());
    expect(dialog(root)!.props.visible).toBe(false);
  });

  it("the dialog's other-device line closes it and opens the panel; without a panel the dialog has no such line", () => {
    const onKeyChange = vi.fn();
    const root = mount({ onErase: async () => undefined, onKeyChange, renderOtherDevice: () => <View testID="app-panel" /> });
    act(() => byId(root, "key-lost-start-new-library")[0]!.props.onPress());
    act(() => dialog(root)!.props.onOtherDevice());
    console.info(SUITE, "dialog other device", JSON.stringify({ visible: dialog(root)!.props.visible, panel: byId(root, "app-panel").length }));
    expect(dialog(root)!.props.visible).toBe(false);
    expect(byId(root, "app-panel")).toHaveLength(1);
    expect(onKeyChange).toHaveBeenLastCalledWith("", { status: "empty" });
    act(() => tree?.unmount());
    const bare = mount({ onErase: async () => undefined });
    expect(dialog(bare)!.props.onOtherDevice).toBeUndefined();
  });

  it("passes the header, Back, the language button, the numbering, busy and the app's overlay through", () => {
    const onBack = vi.fn();
    const onLanguage = vi.fn();
    const root = mount({ header: null, onBack, onLanguage, step: 1, total: 3, busy: true, overlay: <View testID="app-overlay" /> });
    const props = step(root).props;
    expect(props).toMatchObject({ header: null, onBack, onLanguage, step: 1, total: 3, busy: true, title: "Title", body: "Body" });
    expect(byId(root, "app-overlay")).toHaveLength(1);
  });
});

const View = (props: { testID: string }) => React.createElement("View", props);
