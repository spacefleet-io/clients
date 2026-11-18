// @vitest-environment jsdom
/**
 * ACCT-AUTH-09: the server picker on the sign-in and sign-up screens exists in development builds only
 * (`electron-vite dev`, or a `build:test` build with `VITE_SF_DEV_TICKET_KEY=1`); a release build renders nothing,
 * because it trusts the production ticket key only (META-ANON-07) and another server would silently drop every ticket.
 * The picker itself (`ApiHostSettingsButton`) is replaced by a stand-in: this checks the gate, not the dialog.
 *
 * @req ACCT-AUTH-09[badger-desktop]
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthApiHostButton from "../src/renderer/src/components/AuthApiHostButton";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "auth-api-host-button";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@space/shared/api", () => ({ setApiBaseUrl: vi.fn() }));
vi.mock("@space/desktop-shell/components", () => ({
  ApiHostSettingsButton: ({ labels }: { labels: { button: string } }) => <button data-testid="server-picker">{labels.button}</button>,
}));

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
  vi.unstubAllEnvs();
});

const render = (node: React.ReactNode) => {
  act(() => root.render(node));
  const picker = container.querySelector('[data-testid="server-picker"]');
  console.info(`[${SUITE}:render] html=${JSON.stringify(container.innerHTML)} picker=${picker !== null}`);
  return picker;
};

describe("server picker on the auth screens", () => {
  it("a release build shows no server picker", () => {
    console.info(`[${SUITE}:release] start`);
    for (const env of [{ DEV: false }, {}, { DEV: false, VITE_SF_DEV_TICKET_KEY: "" }, { DEV: false, VITE_SF_DEV_TICKET_KEY: "0" }]) {
      console.info(`[${SUITE}:release] env=${JSON.stringify(env)}`);
      expect(render(<AuthApiHostButton buildEnv={env} />)).toBeNull();
      expect(container.innerHTML).toBe("");
    }
  });

  it("a dev build and a build:test build show the server picker", () => {
    console.info(`[${SUITE}:dev] start`);
    for (const env of [{ DEV: true }, { DEV: false, VITE_SF_DEV_TICKET_KEY: "1" }]) {
      console.info(`[${SUITE}:dev] env=${JSON.stringify(env)}`);
      expect(render(<AuthApiHostButton buildEnv={env} />)?.textContent).toBe("authApiHost.button");
    }
  });

  it("without an explicit env it reads the bundle's own build flags", () => {
    console.info(`[${SUITE}:bundle-flags] release stub`);
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SF_DEV_TICKET_KEY", "");
    expect(render(<AuthApiHostButton />)).toBeNull();
    console.info(`[${SUITE}:bundle-flags] dev stub`);
    vi.stubEnv("DEV", true);
    expect(render(<AuthApiHostButton />)).not.toBeNull();
  });
});
