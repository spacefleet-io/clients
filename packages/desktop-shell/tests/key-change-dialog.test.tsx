// @vitest-environment jsdom
/**
 * @test-id DESKTOP-SHELL-KEY-CHANGE-DIALOG-001
 * @level component
 * @req ACCT-KEYCHG-01[badger-desktop,parrot]
 * @req ACCT-KEYCHG-06[badger-desktop,parrot]
 * @req ACCT-KEYCHG-07[badger-desktop,parrot]
 * @req ACCT-KEYCHG-08[badger-desktop,parrot]
 * @req ACCT-KEYCHG-09[badger-desktop,parrot]
 * @req STOR-RESEAL-10[badger-desktop,parrot]
 * @why Chris (2026-11-23, rotate drafts review, relayed by Main): Stop sits under "More options" and asks Keep going /
 *   Stop, never next to the progress; the unreadable files are counted with a "See the N files" link and a delete;
 *   "Switch now" shows only once the switch has waited 24 hours on another device. One dialog serves Badger desktop
 *   and Parrot desktop (REL-FAM-02), naming the app it runs in, in its five languages.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientUiLanguage } from "@space/shared/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A closed dialog renders nothing, as the real one does.
vi.mock("@space/ui", () => {
  const Plain = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: ({ checked, onCheckedChange }: { checked?: boolean; onCheckedChange?: (next: boolean) => void }) => (
      <button type="button" data-checked={checked ? "true" : "false"} onClick={() => onCheckedChange?.(!checked)} />
    ),
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
    DialogContent: Plain,
    DialogFooter: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  };
});
vi.mock("@space/ui/library-key-words", () => ({
  LibraryKeyWordsGrid: ({ words }: { words: string[] }) => <ol data-testid="key-words">{words.map((w) => <li key={w}>{w}</li>)}</ol>,
}));

import {
  KeyChangeDialog,
  KeyChangeResealPanel,
  type KeyChangeDialogProps,
  type KeyChangeDialogView,
} from "../src/components/key-change-dialog";
import { keyChangeCountText, keyChangeEtaText, keyChangeStrings, keyChangeText } from "@space/shared/keyChangeText";

const SUITE = "[key-change-dialog]";
const t = keyChangeText("en");

const view = (over: Partial<KeyChangeDialogView> = {}): KeyChangeDialogView => ({
  phase: "resealing",
  progress: { totalFiles: 10, doneFiles: 4, keptFiles: 0, transferBytes: 2_000, transferredBytes: 800 },
  etaSeconds: 120,
  uploadsInFlight: 0,
  canSwitchNow: false,
  switchNow: vi.fn(),
  stopConfirmOpen: false,
  setStopConfirmOpen: vi.fn(),
  stop: vi.fn(),
  unreadableOpen: false,
  setUnreadableOpen: vi.fn(),
  unreadableFiles: null,
  unreadableBusy: false,
  showUnreadableFiles: vi.fn(),
  deleteUnreadableFiles: vi.fn(),
  ...over,
});

const dialogProps = (over: Partial<KeyChangeDialogProps> = {}): KeyChangeDialogProps => ({
  language: "en",
  app: "Parrot",
  open: true,
  onOpenChange: vi.fn(),
  words: ["alpha", "bravo", "charlie"],
  onCopyWords: vi.fn(),
  confirmed: false,
  onConfirmedChange: vi.fn(),
  hasPassword: true,
  password: "",
  onPasswordChange: vi.fn(),
  needsCode: false,
  code: "",
  onCodeChange: vi.fn(),
  method: null,
  notice: null,
  error: null,
  busy: false,
  onSubmit: vi.fn(),
  view: view({ phase: "form", progress: null }),
  ...over,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const mount = (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
};
const render = (v: KeyChangeDialogView, language: ClientUiLanguage = "en") =>
  mount(<KeyChangeResealPanel language={language} app="Badger" view={v} />);
const rerender = (v: KeyChangeDialogView) => act(() => root!.render(<KeyChangeResealPanel language="en" app="Badger" view={v} />));

const buttons = (el: HTMLElement) => Array.from(el.querySelectorAll("button"));
const button = (el: HTMLElement, text: string) => buttons(el).find((b) => b.textContent === text);
const click = (el: HTMLElement | undefined) => act(() => el!.click());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe(`${SUITE} strings`, () => {
  it("names the app it runs in, in every language", () => {
    for (const [language, strings] of Object.entries(keyChangeStrings)) {
      console.info(SUITE, language, strings["reseal.keepOpen"]);
      expect(strings.resealHint).toContain("{app}");
      expect(strings["reseal.keepOpen"]).toContain("{app}");
      expect(strings.resealHint).not.toMatch(/Badger|Parrot/);
      expect(strings["reseal.keepOpen"]).not.toMatch(/Badger|Parrot/);
    }
    expect(t("reseal.keepOpen", { app: "Parrot" })).toBe(
      "Keep Parrot open until this ends. If Parrot closes, the key change starts over the next time.",
    );
  });

  it("says the media library key in each language's words", () => {
    const words: Record<ClientUiLanguage, string> = {
      en: "media library key",
      fr: "clé de médiathèque",
      de: "Mediathek-Schlüssel",
      es: "clave de la mediateca",
      nl: "mediatheeksleutel",
    };
    for (const [language, word] of Object.entries(words)) {
      expect(keyChangeStrings[language as ClientUiLanguage].keyLabel.toLowerCase()).toContain(word.toLowerCase());
    }
  });

  it("picks the singular or plural by count", () => {
    expect(keyChangeCountText("en", "reseal.unreadable", 1)).toBe("1 file can't be opened with your current key. It stays as it is.");
    expect(keyChangeCountText("en", "reseal.seeFiles", 3)).toBe("See the 3 files");
    expect(keyChangeCountText("fr", "reseal.unreadableDeletedMessage", 2)).toBe("2 fichiers supprimés.");
  });

  it("says the time left in words", () => {
    expect(keyChangeEtaText("en", null)).toBe("Estimating the time left…");
    expect(keyChangeEtaText("en", 30)).toBe("Less than a minute left");
    expect(keyChangeEtaText("en", 241)).toBe("About 5 min left");
    expect(keyChangeEtaText("en", 2 * 3600 + 5 * 60)).toBe("About 2 h 5 min left");
    expect(keyChangeEtaText("de", 241)).toBe("Noch etwa 5 Min.");
  });
});

describe(`${SUITE} form`, () => {
  it("shows the new key, asks the confirm and the password, then submits", () => {
    const props = dialogProps();
    const el = mount(<KeyChangeDialog {...props} />);
    console.info(SUITE, "form text", el.textContent);
    expect(el.querySelector("[data-testid=key-words]")?.textContent).toBe("alphabravocharlie");
    expect(el.textContent).toContain(t("resealHint", { app: "Parrot" }));
    const submit = button(el, t("submit"));
    expect(submit?.disabled).toBe(true);
    act(() => root!.render(<KeyChangeDialog {...props} confirmed password="pw" />));
    click(button(el, t("submit")));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    click(buttons(el).find((b) => b.getAttribute("aria-label") === t("copyButton")));
    expect(props.onCopyWords).toHaveBeenCalledTimes(1);
  });

  it("ACCT-AUTH-04: an account without a password is asked no password", () => {
    const el = mount(<KeyChangeDialog {...dialogProps({ hasPassword: false, confirmed: true })} />);
    expect(el.querySelector("#keyChangePassword")).toBeNull();
    expect(el.querySelector("[data-testid=keyChangePassword-no-password]")?.textContent).toBe(t("noPasswordHint"));
    expect(button(el, t("submit"))?.disabled).toBe(false);
  });

  it("asks the code the API wants", () => {
    const el = mount(<KeyChangeDialog {...dialogProps({ needsCode: true, method: "totp" })} />);
    expect(el.querySelector("#keyChangeCode")).not.toBeNull();
    expect(el.textContent).toContain(t("codeHintTotp"));
  });

  it("offers Finish once every file is copied, without the form", () => {
    const el = mount(<KeyChangeDialog {...dialogProps({ confirmed: true, password: "pw", view: view({ phase: "ready" }) })} />);
    expect(el.textContent).toContain(t("reseal.readyTitle"));
    expect(button(el, t("reseal.finish"))).toBeDefined();
    expect(button(el, t("cancel"))).toBeUndefined();
    expect(el.querySelector("#keyChangePassword")).toBeNull();
  });
});

describe(`${SUITE} progress`, () => {
  it("shows the share of bytes moved, the files and the estimate", () => {
    const el = render(view());
    const bar = el.querySelector("[role=progressbar]");
    console.log(`${SUITE} text=${el.textContent}`);
    expect(bar?.getAttribute("aria-valuenow")).toBe("40");
    expect(el.textContent).toContain(t("reseal.files", { done: 4, total: 10 }));
    expect(el.textContent).toContain("About 2 min left");
    expect(el.textContent).toContain(t("reseal.keepOpen", { app: "Badger" }));
  });
});

describe(`${SUITE} stop`, () => {
  it("sits under More options, never next to the progress", () => {
    const v = view();
    const el = render(v);
    console.log(`${SUITE} buttons=${JSON.stringify(buttons(el).map((b) => b.textContent))}`);
    expect(button(el, t("reseal.stop"))).toBeUndefined();
    click(button(el, t("reseal.moreOptions")));
    click(button(el, t("reseal.stop")));
    expect(v.setStopConfirmOpen).toHaveBeenCalledWith(true);
    expect(v.stop).not.toHaveBeenCalled();
  });

  it("asks Keep going / Stop, and only Stop stops", () => {
    const v = view({ stopConfirmOpen: true });
    const el = render(v);
    expect(el.querySelector("[role=dialog]")?.textContent).toContain(t("reseal.stopTitle"));
    click(button(el, t("reseal.keepGoing")));
    expect(v.setStopConfirmOpen).toHaveBeenCalledWith(false);
    expect(v.stop).not.toHaveBeenCalled();
    click(button(el, t("reseal.stopConfirm")));
    expect(v.stop).toHaveBeenCalledTimes(1);
  });
});

describe(`${SUITE} unreadable files`, () => {
  it("counts them with a See the N files link, and none when every file opened", () => {
    expect(render(view()).textContent).not.toContain("can't be opened");
    act(() => root!.unmount());
    const v = view({ progress: { totalFiles: 10, doneFiles: 10, keptFiles: 3, transferBytes: 2_000, transferredBytes: 2_000 } });
    const el = render(v);
    expect(el.textContent).toContain(keyChangeCountText("en", "reseal.unreadable", 3));
    click(button(el, "See the 3 files"));
    expect(v.showUnreadableFiles).toHaveBeenCalledTimes(1);
  });

  it("lists them with a delete", () => {
    const v = view({
      unreadableOpen: true,
      unreadableFiles: [
        { key: "u/a", sizeBytes: 10 },
        { key: "u/b", sizeBytes: 20 },
      ],
    });
    const el = render(v);
    const items = Array.from(el.querySelectorAll("li")).map((li) => li.textContent);
    console.log(`${SUITE} items=${JSON.stringify(items)}`);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("u/a");
    click(button(el, "Delete 2 files"));
    expect(v.deleteUnreadableFiles).toHaveBeenCalledTimes(1);
  });

  it("offers no delete while there is nothing to delete", () => {
    const el = render(view({ unreadableOpen: true, unreadableFiles: [] }));
    expect(button(el, "Delete 0 files")?.disabled).toBe(true);
  });
});

describe(`${SUITE} waiting on another device`, () => {
  it("offers Switch now only once the app says 24 hours have passed", () => {
    const v = view({ phase: "waiting", uploadsInFlight: 2 });
    const el = render(v);
    expect(el.textContent).toContain(keyChangeCountText("en", "reseal.waitingBody", 2));
    expect(button(el, t("reseal.switchNow"))).toBeUndefined();
    rerender({ ...v, canSwitchNow: true });
    expect(el.textContent).toContain(t("reseal.switchNowBody"));
    click(button(el, t("reseal.switchNow")));
    expect(v.switchNow).toHaveBeenCalledTimes(1);
  });
});
