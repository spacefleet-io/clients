// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-KEY-SAVED-WARNING-001
 * @level unit
 * @req ACCT-DEV-04[parrot]
 * @req UX-KEY-01[parrot]
 * @why Chris (2026-11-11): people who don't know what encryption is click through "store your key somewhere safe".
 *   An account with no key yet is shown a new one on the setup key step (the shared LibraryKeyStep, as on Badger)
 *   with one plain line, and its main button reads "I've written it down"; only then is the key kept (setLibraryKey,
 *   which claims the account). It opens a plain warning: only "Yes, I understand" moves on; "Go back" keeps the
 *   same key on screen.
 *   Chris (2026-11-12): "It asks for a key but lists the words underneath the input field? … None of these makes
 *   sense." So the screen that shows a new key is titled "Your media library key" (never "Enter your media library key") and has
 *   no input field (UX-KEY-01).
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotState } from "../src/shared/ipc";
import type { KeySavedWarningText } from "@space/shared/keySavedWarning";
import { generateLibraryKeyWords, libraryKeyWordsText } from "@space/shared/libraryKeyWords";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-KEY-SAVED-WARNING-001]";

vi.mock("@space/ui", () => {
  const Pass = ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>;
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      const { size: _size, variant: _variant, ...rest } = props;
      return <button {...rest}>{children}</button>;
    },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: ({ children }: { children?: React.ReactNode }) => <label>{children}</label>,
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Spinner: () => <span />,
    LanguageMenu: () => <div data-testid="language-menu" />,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    // The shared dialog has its own test in packages/ui; here only its open state and its two answers matter.
    KeySavedWarningDialog: (props: { open: boolean; text: KeySavedWarningText; onConfirm: () => void; onBack: () => void }) =>
      props.open ? (
        <div data-testid="key-saved-warning">
          {props.text.title} {props.text.needed} {props.text.noReset} {props.text.lost}
          <button data-testid="key-saved-warning-back" onClick={props.onBack}>
            {props.text.back}
          </button>
          <button data-testid="key-saved-warning-confirm" onClick={props.onConfirm}>
            {props.text.confirm}
          </button>
        </div>
      ) : null,
  };
});
vi.mock("../src/renderer/src/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: vi.fn(), dialog: null }) }));

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const state: ParrotState = {
  setup: { step: "libraryKey", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

describe("@req ACCT-DEV-04 Parrot desktop new key: I've written it down, then the warning", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ParrotState;
  const setLibraryKey = vi.fn(async (_key: string) => ({ ok: true as const }));
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => ({ ...current, setup: { ...current.setup, ...patch } }));
  const q = (testId: string) => host.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const created = generateLibraryKeyWords("en", (bytes) => bytes.fill(5));
  const shownWords = () =>
    Array.from(host.querySelectorAll('[data-testid="key-created"] [data-testid="library-key-word"]')).map(
      (item) => item.lastElementChild?.textContent ?? "",
    );
  const render = () => act(() => root.render(<Setup t={translator("en")} state={current} onState={(next) => ((current = next), render())} />));
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: saved-button=${q("key-saved")?.textContent ?? "none"} warning=${q("key-saved-warning") !== null} key=${shownWords().join(" ") || "none"} setupSaves=${saveSetup.mock.calls.length} keyKept=${JSON.stringify(setLibraryKey.mock.calls)}`,
    );
  const click = (testId: string) => act(async () => q(testId)!.click());

  beforeEach(async () => {
    vi.clearAllMocks();
    current = state;
    (window as unknown as { parrot: unknown }).parrot = {
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      createLibraryKey: vi.fn(async () => ({ ok: true, ...created })),
      setLibraryKey,
      getState: vi.fn(async () => ({ ...state, hasLibraryKey: true })),
      saveSetup,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => render());
    dump("arrived");
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the new key as 12 numbered words with Copy and one plain line, no input, and the button reads I've written it down", async () => {
    dump("created");
    expect(shownWords()).toEqual(created.words);
    expect(Array.from(host.querySelectorAll('[data-testid="library-key-word"]')).map((item) => item.firstElementChild?.textContent)).toEqual(
      created.words.map((_, index) => String(index + 1)),
    );
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => q("key-copy")!.click());
    console.info(`${SUITE} copied=${JSON.stringify(writeText.mock.calls)}`);
    expect(writeText).toHaveBeenCalledWith(libraryKeyWordsText(created.words));
    expect(q("key-created-line")?.textContent).toBe(
      "Save this key somewhere safe: you'll need it to sign in on any new device, and if it's lost, nobody, not even us, can get your library back.",
    );
    expect(host.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
    const fields = host.querySelectorAll("input, textarea").length;
    console.info(`${SUITE} show screen text=${JSON.stringify(host.textContent?.slice(0, 80))} fields=${fields}`);
    // UX-KEY-01: the show screen never looks like the enter screen: its own title, and nothing to type into.
    expect(host.textContent).toContain("Your media library key");
    expect(host.textContent).not.toContain("Enter your media library key");
    expect(fields).toBe(0);
    expect(q("library-key-input")).toBeNull();
    expect(q("key-saved")?.textContent).toBe("I've written it down");
    expect(q("setup-next")).toBeNull();
    expect(q("key-saved-warning")).toBeNull();
    // Nothing is kept before the user says the key is written down.
    expect(setLibraryKey).not.toHaveBeenCalled();
  });

  it("opens the warning, and Go back keeps the same key without moving on", async () => {
    await click("key-saved");
    dump("saved-clicked");
    expect(q("key-saved-warning")?.textContent).toContain("If you lose it, your library can't be recovered, by anyone, including us.");
    expect(saveSetup).not.toHaveBeenCalled();
    await click("key-saved-warning-back");
    dump("went-back");
    expect(q("key-saved-warning")).toBeNull();
    expect(shownWords()).toEqual(created.words);
    expect(saveSetup).not.toHaveBeenCalled();
    expect(setLibraryKey).not.toHaveBeenCalled();
  });

  it("moves to the next step only on Yes, I understand", async () => {
    await click("key-saved");
    expect(q("key-saved-warning-confirm")?.textContent).toBe("Yes, I understand");
    await click("key-saved-warning-confirm");
    dump("confirmed");
    expect(setLibraryKey).toHaveBeenCalledWith(created.keyBase64);
    expect(saveSetup).toHaveBeenCalledTimes(1);
    expect(saveSetup.mock.calls[0]![0].step).toBe("folders");
    expect(q("key-saved-warning")).toBeNull();
  });
});
