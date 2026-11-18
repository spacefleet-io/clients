/**
 * @test-id MOBILE-SHELL-ERASE-LIBRARY-DIALOG-001
 * @level unit
 * @why Chris (2026-11-12): the key step's "Lost your key? Erase this library and start over" opens a danger dialog
 *   "Erase this library?" that needs ERASE plus the account password, with Cancel as the safe first action. Main
 *   (2026-11-12): the erase is account-wide, so the text names the Badger and Parrot libraries. The phone and TV apps
 *   share this dialog; these tests mount it and drive the fields, the button and the server's rejections.
 * @req UX-KEY-01[badger-mobile,badger-tv,parrot]
 * @req UX-TV-17[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isTV: false }));
vi.mock("react-native", () => ({
  Platform: platform,
  ScrollView: "ScrollView",
  Modal: "Modal",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("../src/components/mobile-button-face", () => ({ MobileButtonFace: "MobileButtonFace" }));
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { text: "#fff", textMuted: "#999", controlBorder: "#333", surface: "#111", surfaceRaised: "#222", border: "#444", danger: "#e00", accent: "#f4a261" },
    accentTextHex: "#000",
  }),
}));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

import en from "../src/i18n/en.json";
import de from "../src/i18n/de.json";
import es from "../src/i18n/es.json";
import fr from "../src/i18n/fr.json";
import nl from "../src/i18n/nl.json";
import { ERASE_CONFIRM_WORD, MobileEraseLibraryDialog } from "../src/components/mobile-erase-library-dialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const SUITE = "[MOBILE-SHELL-ERASE-LIBRARY-DIALOG-001]";
const flatStyle = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatStyle)) : style && typeof style === "object" ? (style as Record<string, unknown>) : {};

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  platform.isTV = false;
  act(() => renderer?.unmount());
  renderer = null;
});

const mount = (onConfirm: (password: string, code?: string) => Promise<void>, onCancel = vi.fn(), hasPassword = true) => {
  act(() => {
    renderer = create(<MobileEraseLibraryDialog visible onCancel={onCancel} onConfirm={onConfirm} hasPassword={hasPassword} />);
  });
  const root = renderer!.root;
  const byId = (id: string): ReactTestInstance => root.find((n: ReactTestInstance) => n.props.testID === id && typeof n.type === "string");
  const maybe = (id: string) => root.findAll((n: ReactTestInstance) => n.props.testID === id && typeof n.type === "string")[0];
  const type = (id: string, text: string) => act(() => byId(id).props.onChangeText(text));
  const press = async (id: string) => {
    await act(async () => {
      byId(id).props.onPress();
    });
  };
  return { root, byId, maybe, type, press, onCancel };
};

describe("MobileEraseLibraryDialog", () => {
  it("enables the erase button only once ERASE (exactly) and a password are typed", () => {
    const ui = mount(vi.fn(async () => undefined));
    const disabled = () => ui.byId("erase-library-submit").props.disabled;
    expect(disabled()).toBe(true);
    ui.type("erase-library-confirm", "erase");
    ui.type("erase-library-password", "hunter2");
    console.info(SUITE, "lowercase word keeps it disabled:", disabled());
    expect(disabled()).toBe(true);
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "");
    expect(disabled()).toBe(true);
    ui.type("erase-library-password", "hunter2");
    console.info(SUITE, "ERASE + password enables it:", !disabled());
    expect(disabled()).toBe(false);
  });

  it("puts Cancel first, keeps the ERASE field free of suggestions and hides the password", () => {
    const ui = mount(vi.fn(async () => undefined));
    const buttons = ui.root.findAll((n: ReactTestInstance) => String(n.type) === "MobileButtonFace");
    expect(buttons.map((b: ReactTestInstance) => b.props.testID)).toEqual(["erase-library-cancel", "erase-library-submit"]);
    expect(buttons[1]?.props.variant).toBe("danger");
    console.info(SUITE, "TV preferred focus:", buttons.map((b: ReactTestInstance) => `${b.props.testID}=${b.props.hasTVPreferredFocus}`).join(","));
    expect(buttons.filter((b: ReactTestInstance) => b.props.hasTVPreferredFocus).map((b: ReactTestInstance) => b.props.testID)).toEqual(["erase-library-cancel"]);
    expect(ui.root.findAll((n: ReactTestInstance) => String(n.type) === "TextInput" && n.props.autoFocus)).toHaveLength(0);
    const word = ui.byId("erase-library-confirm").props;
    expect([word.autoCorrect, word.spellCheck, word.autoComplete, word.importantForAutofill]).toEqual([false, false, "off", "no"]);
    expect(ui.byId("erase-library-password").props.secureTextEntry).toBe(true);
    // The phone keeps its stacked layout: no row holds the two fields, the card stays 440 wide with the roomy padding.
    const rows = ui.root.findAll((n: ReactTestInstance) => String(n.type) === "View" && flatStyle(n.props.style).flexDirection === "row");
    const phoneContent = flatStyle(ui.root.findAll((n: ReactTestInstance) => String(n.type) === "ScrollView")[0]!.props.contentContainerStyle);
    console.info(SUITE, "phone", JSON.stringify({ rows: rows.length, content: phoneContent }));
    expect(rows.filter((r: ReactTestInstance) => r.findAll((m) => String(m.type) === "TextInput").length > 0)).toHaveLength(0);
    expect(flatStyle(ui.byId("erase-library-dialog").props.style).maxWidth).toBe(440);
    expect(phoneContent).toMatchObject({ padding: 20, gap: 12 });
  });

  it("on TV: a wider, tighter card that fits 540dp, ERASE and password side by side, Cancel and Erase side by side with Cancel first, a ring on the field the remote is on", () => {
    platform.isTV = true;
    const ui = mount(vi.fn(async () => undefined));
    const card = flatStyle(ui.byId("erase-library-dialog").props.style);
    const scroll = ui.root.findAll((n: ReactTestInstance) => String(n.type) === "ScrollView");
    const row = ui.root.find(
      (n: ReactTestInstance) => String(n.type) === "View" && flatStyle(n.props.style).flexDirection === "row" && n.findAll((m) => String(m.type) === "MobileButtonFace").length === 2
    );
    const inRow = row.findAll((n: ReactTestInstance) => String(n.type) === "MobileButtonFace").map((b: ReactTestInstance) => b.props.testID);
    const fieldsRow = ui.root.find(
      (n: ReactTestInstance) => String(n.type) === "View" && flatStyle(n.props.style).flexDirection === "row" && n.findAll((m) => String(m.type) === "TextInput").length === 2
    );
    const fieldsInRow = fieldsRow.findAll((n: ReactTestInstance) => String(n.type) === "TextInput").map((f: ReactTestInstance) => f.props.testID);
    const content = flatStyle(scroll[0]!.props.contentContainerStyle);
    console.info(SUITE, "tv", JSON.stringify({ card, content, scrolls: scroll.length, inRow, fieldsInRow }));
    expect(card.maxWidth).toBe(760);
    expect(card.maxHeight).toBe("100%");
    expect(content).toMatchObject({ padding: 16, gap: 8 });
    expect(scroll).toHaveLength(1);
    expect(fieldsInRow).toEqual(["erase-library-confirm", "erase-library-password"]);
    expect(inRow).toEqual(["erase-library-cancel", "erase-library-submit"]);
    expect(ui.byId("erase-library-cancel").props.hasTVPreferredFocus).toBe(true);
    const confirmBorder = () => flatStyle(ui.byId("erase-library-confirm").props.style).borderColor;
    expect(confirmBorder()).toBe("#333");
    act(() => ui.byId("erase-library-confirm").props.onFocus());
    console.info(SUITE, "tv focused field border", confirmBorder(), flatStyle(ui.byId("erase-library-confirm").props.style).borderWidth);
    expect(confirmBorder()).toBe("#f4a261");
    expect(flatStyle(ui.byId("erase-library-password").props.style).borderColor).toBe("#333");
    act(() => ui.byId("erase-library-confirm").props.onBlur());
    expect(confirmBorder()).toBe("#333");
  });

  it("hands the password to onConfirm", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const ui = mount(onConfirm);
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "hunter2");
    await ui.press("erase-library-submit");
    console.info(SUITE, "onConfirm calls:", JSON.stringify(onConfirm.mock.calls));
    expect(onConfirm).toHaveBeenCalledWith("hunter2", undefined);
  });

  it("shows a pending state while onConfirm runs", async () => {
    const pending = Promise.withResolvers<void>();
    const ui = mount(() => pending.promise);
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "hunter2");
    await ui.press("erase-library-submit");
    const submit = ui.byId("erase-library-submit").props;
    expect([submit.loading, submit.label]).toEqual([true, "eraseLibrary.working"]);
    expect(ui.byId("erase-library-cancel").props.disabled).toBe(true);
    await act(async () => pending.resolve());
    expect(ui.byId("erase-library-submit").props.loading).toBe(false);
  });

  it("shows the rejection's message and re-enables the button", async () => {
    const ui = mount(vi.fn(async () => Promise.reject(new Error("Network is down."))));
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "hunter2");
    await ui.press("erase-library-submit");
    const shown = ui.byId("erase-library-error").props.children;
    console.info(SUITE, "error shown:", shown);
    expect(shown).toBe("Network is down.");
    expect(ui.byId("erase-library-submit").props.disabled).toBe(false);
  });

  it("translates the server's wrong-password answer", async () => {
    const ui = mount(vi.fn(async () => Promise.reject({ status: 401, payload: { error: "invalid_password" } })));
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "nope");
    await ui.press("erase-library-submit");
    expect(ui.byId("erase-library-error").props.children).toBe("eraseLibrary.errorInvalidPassword");
  });

  it("asks for the two-factor code when the server wants one and sends it next time", async () => {
    const onConfirm = vi
      .fn<(password: string, code?: string) => Promise<void>>()
      .mockRejectedValueOnce({ status: 401, payload: { error: "two_factor_required", method: "email" } })
      .mockResolvedValueOnce(undefined);
    const ui = mount(onConfirm);
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    ui.type("erase-library-password", "hunter2");
    await ui.press("erase-library-submit");
    expect(ui.byId("erase-library-notice").props.children).toBe("eraseLibrary.codeSent");
    expect(ui.byId("erase-library-submit").props.disabled).toBe(true);
    ui.type("erase-library-code", " 123456 ");
    await ui.press("erase-library-submit");
    console.info(SUITE, "onConfirm calls:", JSON.stringify(onConfirm.mock.calls));
    expect(onConfirm).toHaveBeenLastCalledWith("hunter2", "123456");
    expect(ui.maybe("erase-library-error")).toBeUndefined();
  });

  it("@req ACCT-AUTH-04 an account without a password gets no password field: the first try sends the code, then it erases", async () => {
    const onConfirm = vi
      .fn<(password: string, code?: string) => Promise<void>>()
      .mockRejectedValueOnce({ status: 401, payload: { error: "two_factor_required", method: "email" } })
      .mockResolvedValueOnce(undefined);
    const ui = mount(onConfirm, vi.fn(), false);
    expect(ui.maybe("erase-library-password")).toBeUndefined();
    expect(ui.byId("erase-library-recheck-hint").props.children).toBe("login.code.recheckHint");
    ui.type("erase-library-confirm", ERASE_CONFIRM_WORD);
    console.info(SUITE, "no password: ERASE alone enables it:", !ui.byId("erase-library-submit").props.disabled);
    expect(ui.byId("erase-library-submit").props.disabled).toBe(false);
    await ui.press("erase-library-submit");
    expect(onConfirm).toHaveBeenLastCalledWith("", undefined);
    expect(ui.byId("erase-library-notice").props.children).toBe("eraseLibrary.codeSent");
    ui.type("erase-library-code", "123456");
    await ui.press("erase-library-submit");
    console.info(SUITE, "onConfirm calls without a password:", JSON.stringify(onConfirm.mock.calls));
    expect(onConfirm).toHaveBeenLastCalledWith("", "123456");
  });

  it("points to the other-device route before the ERASE field only when the app offers it", async () => {
    expect(mount(vi.fn(async () => undefined)).maybe("erase-library-other-device")).toBeUndefined();
    act(() => renderer?.unmount());
    const onOtherDevice = vi.fn();
    act(() => {
      renderer = create(
        <MobileEraseLibraryDialog visible onCancel={vi.fn()} onConfirm={vi.fn(async () => undefined)} onOtherDevice={onOtherDevice} />,
      );
    });
    const ids = renderer!.root
      .findAll((n: ReactTestInstance) => typeof n.props.testID === "string" && typeof n.type === "string")
      .map((n: ReactTestInstance) => n.props.testID as string);
    console.info(SUITE, "order:", ids.join(","));
    expect(ids.indexOf("erase-library-other-device")).toBeLessThan(ids.indexOf("erase-library-confirm"));
    const preferred = renderer!.root.findAll((n: ReactTestInstance) => String(n.type) === "MobileButtonFace" && n.props.hasTVPreferredFocus);
    expect(preferred.map((n: ReactTestInstance) => n.props.testID)).toEqual(["erase-library-cancel"]);
    await act(async () => {
      renderer!.root.find((n: ReactTestInstance) => n.props.testID === "erase-library-other-device").props.onPress();
    });
    expect(onOtherDevice).toHaveBeenCalledTimes(1);
  });

  it("Cancel calls onCancel", async () => {
    const onCancel = vi.fn();
    const ui = mount(vi.fn(async () => undefined), onCancel);
    await ui.press("erase-library-cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ships every string in every shell language, names both apps and keeps the literal word in the label", () => {
    const keys = Object.keys(en.eraseLibrary).sort();
    for (const [lang, bundle] of Object.entries({ en, de, es, fr, nl })) {
      const texts: Record<string, string> = bundle.eraseLibrary;
      expect(Object.keys(texts).sort(), lang).toEqual(keys);
      expect(texts.warning, lang).toMatch(/Badger.*Parrot/);
      expect(texts.otherDeviceLine, lang).toMatch(/Badger.*Parrot/);
      expect(texts.confirmLabel, lang).toContain("{{word}}");
    }
  });

  it("says what the desktop erase dialog says: the whole account's library, every profile, both apps, no undo, the other-device route", () => {
    // UX-KEY-01: these strings are copied word for word from packages/desktop-shell/src/components/library-key-step-strings.ts,
    // with the app's word for the collection (UX-NAME-03): the shared files carry Badger's, Parrot sets its own.
    const withWord = (text: string, bundle: { keyStepWords: { collection: string } }) =>
      text.replace("$t(keyStepWords.collection)", bundle.keyStepWords.collection);
    console.log("[erase-dialog] en warning:", withWord(en.eraseLibrary.warning, en));
    expect(withWord(en.eraseLibrary.warning, en)).toBe(
      "This erases the entire media library of this account, for every profile: all music, movies and shows, and all their details (metadata, playlists, history, settings), in Badger and Parrot. Nobody can undo this, not even us. Your account and plan stay.",
    );
    expect(en.eraseLibrary.otherDeviceLine).toBe(
      "Still signed in somewhere? Any Badger or Parrot app works, on any computer, phone or TV, even on another profile of this account. Get your key from there.",
    );
    expect(fr.eraseLibrary.warning).toContain("pas même nous");
    expect(withWord(de.eraseLibrary.title, de)).toBe("Diese Mediathek löschen?");
  });
});
