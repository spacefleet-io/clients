// @vitest-environment jsdom

/**
 * @test-id BADGER-DESKTOP-APP-UPDATE-REQUIRED-001
 * @level integration (renderer, jsdom) + unit
 *
 * @why REL-CD-29 (@req REL-CD-29[badger-desktop]): an installed desktop build states `badger/desktop/<version>` on its
 *   API calls (an unpackaged run states nothing), and once any call is refused with "please update" the app shows the
 *   shared blocking update screen (on every screen, sign-in included, the same one Parrot shows) and checks for the
 *   update, instead of failing call after call. The library gate below the routes leaves that case to it, so two
 *   prompts never stack.
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@space/sdk";
import {
  __resetAppVersionStateForTests,
  clientIdentityHeaders,
  getAppUpdateRequired,
  setClientIdentity,
} from "@space/shared/appVersion";
import { desktopClientIdentity } from "@space/desktop-shell/client-identity";
import AppUpdateRequiredGate from "@/components/AppUpdateRequiredGate";
import LibraryUpdateGate from "@/components/LibraryUpdateGate";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "app-update-required";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, disabled, pending, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) =>
    React.createElement("button", { onClick, disabled: disabled || pending, ...rest }, children),
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? React.createElement("div", { "data-testid": "dialog" }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", { "data-testid": "dialog-title" }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  Switch: ({ checked, onCheckedChange, ...rest }: { checked: boolean; onCheckedChange: (next: boolean) => void }) =>
    React.createElement("button", { role: "switch", "aria-checked": checked, onClick: () => onCheckedChange(!checked), ...rest }),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => React.createElement("span", null, "[!]"),
  ArrowUpCircle: () => React.createElement("span", null, "[↑]"),
  CheckCircle2: () => React.createElement("span", null, "[✓]"),
  Download: () => React.createElement("span", null, "[↓]"),
  Loader2: () => React.createElement("span", null, "[…]"),
  RefreshCw: () => React.createElement("span", null, "[↺]"),
  RotateCw: () => React.createElement("span", null, "[⟳]"),
}));

const mockUseUpdater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/useUpdater", () => ({ useUpdater: mockUseUpdater }));
vi.mock("@/lib/libraryContext", () => ({ useLibraryShell: () => ({ formatTooNew: null }) }));
vi.mock("@/lib/settings/useClientSettings", () => ({
  useClientSettings: () => ({ config: { autoUpdate: true }, updateSetting: vi.fn() }),
}));

const refusalPayload = {
  error: "app_update_required",
  app: "badger",
  platform: "desktop",
  version: "0.4.0",
  minVersion: "0.5.0",
};

const makeUpdater = (mandatory: boolean) => ({
  state: {
    phase: "available",
    version: "0.5.0",
    progress: 0,
    errorMessage: null,
    releaseNotes: null,
    mandatory,
    autoUpdate: true,
  },
  supported: true,
  check: vi.fn(async () => "available"),
  download: vi.fn(async () => undefined),
  install: vi.fn(),
  runFullUpdate: vi.fn(async () => undefined),
  reset: vi.fn(),
});

let container: HTMLDivElement;
let root: Root;

const dump = (testId: string, label: string) =>
  log(testId, `dom:${label}`, {
    screens: container.querySelectorAll("[data-testid='update-required']").length,
    dialogs: container.querySelectorAll("[data-testid='dialog']").length,
    titles: Array.from(container.querySelectorAll("#update-required-title")).map((el) => el.textContent),
    buttons: Array.from(container.querySelectorAll("button")).map((b) => b.textContent),
    refusal: getAppUpdateRequired(),
  });

/** The shared update-required screen, and any library-gate dialog stacked on it (there must be none). */
const screens = () => ({
  required: container.querySelectorAll("[data-testid='update-required']").length,
  dialogs: container.querySelectorAll("[data-testid='dialog']").length,
});

beforeEach(() => {
  __resetAppVersionStateForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mockUseUpdater.mockReset();
  __resetAppVersionStateForTests();
});

describe("REL-CD-29 desktop: the build says its version", () => {
  it("states badger/desktop/<version> for an installed build only @req REL-CD-29[badger-desktop]", () => {
    const testId = "identity";
    const cases = [
      { version: "0.4.0", packaged: true },
      { version: "1.2.3-beta.1", packaged: true },
      { version: "0.4.0", packaged: false },
      { version: "0.0", packaged: true },
    ].map((input) => ({
      ...input,
      identity: desktopClientIdentity({ app: "badger", ...input, os: "win32", env: {} }),
    }));
    log(testId, "cases", cases);
    expect(cases.map((c) => c.identity)).toEqual([
      { app: "badger", platform: "desktop", version: "0.4.0" },
      { app: "badger", platform: "desktop", version: "1.2.3-beta.1" },
      null,
      null,
    ]);

    setClientIdentity(cases[0].identity);
    const headers = clientIdentityHeaders();
    log(testId, "headers", headers);
    expect(headers).toEqual({ "x-space-client": "badger/desktop/0.4.0" });
    setClientIdentity(cases[2].identity);
    expect(clientIdentityHeaders()).toEqual({});
  });
});

describe("REL-CD-29 desktop: a refused build shows the update prompt", () => {
  it("shows the blocking update prompt and checks once for the update @req REL-CD-29[badger-desktop]", async () => {
    const testId = "gate";
    const updater = makeUpdater(false);
    mockUseUpdater.mockReturnValue(updater);

    log(testId, "phase:refuse");
    new ApiError(426, refusalPayload);
    const refusal = getAppUpdateRequired();
    log(testId, "latched", refusal);
    expect(refusal).toMatchObject({ platform: "desktop", minVersion: "0.5.0" });

    log(testId, "phase:render");
    await act(async () => root.render(<AppUpdateRequiredGate refusal={refusal!} />));
    dump(testId, "after-render");
    expect(screens()).toEqual({ required: 1, dialogs: 0 });
    expect(container.querySelector("#update-required-title")?.textContent).toBe("Update Badger to keep using it");
    expect(container.querySelector("[data-testid='update-section-action']")?.getAttribute("data-action")).toBe("download");
    expect(updater.check).toHaveBeenCalledTimes(1);

    log(testId, "phase:second-refusal");
    new ApiError(426, { ...refusalPayload, minVersion: "0.6.0" });
    await act(async () => root.render(<AppUpdateRequiredGate refusal={getAppUpdateRequired()!} />));
    dump(testId, "after-second-refusal");
    expect(getAppUpdateRequired()).toBe(refusal);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it("other API errors are no refusal @req REL-CD-29[badger-desktop]", () => {
    new ApiError(401, { error: "unauthorized" });
    new ApiError(426, { error: "something_else" });
    log("not-refusal", "latched", getAppUpdateRequired());
    expect(getAppUpdateRequired()).toBeNull();
  });

  it("a release-status mandatory build gets the same one prompt, before and after a refusal @req REL-CD-29[badger-desktop]", async () => {
    const testId = "release-status-mandatory";
    const updater = makeUpdater(true);
    mockUseUpdater.mockReturnValue(updater);

    // `App` mounts the app-level gate for either signal; the library gate (signed-in screens only) leaves both to it.
    log(testId, "phase:release-status-mandatory");
    await act(async () =>
      root.render(
        <>
          <AppUpdateRequiredGate refusal={null} />
          <LibraryUpdateGate />
        </>,
      ),
    );
    dump(testId, "before-refusal");
    expect(screens()).toEqual({ required: 1, dialogs: 0 });
    // The mandatory answer came from a check main already ran: nothing more to check.
    expect(updater.check).not.toHaveBeenCalled();

    log(testId, "phase:refuse");
    await act(async () => {
      new ApiError(426, refusalPayload);
    });
    await act(async () =>
      root.render(
        <>
          <AppUpdateRequiredGate refusal={getAppUpdateRequired()} />
          <LibraryUpdateGate />
        </>,
      ),
    );
    dump(testId, "after-refusal");
    expect(screens()).toEqual({ required: 1, dialogs: 0 });
    expect(updater.check).toHaveBeenCalledTimes(1);
  });
});
