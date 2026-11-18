// @vitest-environment jsdom
/**
 * DEV-LIB-01: the desktop asks the user before a third-party tool reaches the library (prompt with the tool's
 * self-declared name, reason and verification code; approve, approve read-only, deny) and lists the approved
 * tools with a Revoke button (Settings → Connected tools).
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAccessSnapshot } from "@space/tool-access/contracts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18n = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}` : key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { rendererLogger: log };
});
import ToolAccessPrompt from "../src/renderer/src/components/ToolAccessPrompt";
import ConnectedToolsSection from "../src/renderer/src/components/settings/sections/ConnectedToolsSection";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const pendingWrite: ToolAccessSnapshot = {
  pending: [
    {
      requestId: "req-1",
      toolName: "my-script",
      reason: "sync my watchlist",
      mode: "write",
      verificationCode: "4821-7733",
      requestedAt: minutesAgo(0),
      expiresAt: minutesAgo(-2),
    },
  ],
  grants: [],
};

const withGrants: ToolAccessSnapshot = {
  pending: [],
  grants: [
    { grantId: "g-1", toolName: "backup-tool", mode: "read", grantedAt: minutesAgo(30), lastUsedAt: minutesAgo(2), expiresAt: minutesAgo(-400) },
    { grantId: "g-2", toolName: "importer", mode: "write", grantedAt: minutesAgo(120), lastUsedAt: null, expiresAt: minutesAgo(-300) },
  ],
};

type Bridge = NonNullable<Window["sf"]>["toolAccess"];

describe("tool access desktop UI", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ToolAccessSnapshot;
  let pushUpdate: (next: ToolAccessSnapshot) => void;
  const decide = vi.fn(async () => ({ ok: true }));
  const revoke = vi.fn(async () => ({ ok: true }));

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const mount = async (node: React.ReactNode) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(node));
    await flush();
  };
  const install = (initial: ToolAccessSnapshot) => {
    snapshot = initial;
    const bridge: Bridge = {
      getSnapshot: async () => snapshot,
      decide,
      revoke,
      onUpdate: (callback) => {
        pushUpdate = (next) => {
          snapshot = next;
          callback(next);
        };
        return () => undefined;
      },
    };
    window.sf = { toolAccess: bridge };
  };
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((b) => b.textContent === label);
  const click = async (label: string) => {
    const target = button(label);
    expect(target, `button ${label}`).toBeDefined();
    await act(async () => target?.click());
    await flush();
  };

  /** The prompt arms its buttons after a delay: only the timers it uses are faked, React's scheduler keeps running. */
  const arm = async (ms = 1000) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    delete window.sf;
  });

  it("shows nothing until a tool asks, then names the tool as self-declared with its reason and code", async () => {
    install({ pending: [], grants: [] });
    await mount(<ToolAccessPrompt />);
    expect(document.body.querySelector('[data-testid="tool-access-prompt"]')).toBeNull();

    await act(async () => pushUpdate(pendingWrite));
    await flush();

    const prompt = document.body.querySelector('[data-testid="tool-access-prompt"]');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toContain("toolAccess.prompt.title|name=my-script");
    expect(prompt?.textContent).toContain("toolAccess.prompt.selfDeclared");
    expect(prompt?.textContent).toContain("sync my watchlist");
    expect(document.body.querySelector('[data-testid="tool-access-code"]')?.textContent).toBe("4821-7733");
  });

  it("approves with the access that was asked", async () => {
    install(pendingWrite);
    await mount(<ToolAccessPrompt />);
    await arm();
    await click("toolAccess.prompt.approve.write");
    expect(decide).toHaveBeenCalledWith({ requestId: "req-1", decision: "approve" });
  });

  it("lets the user approve a write request as read only", async () => {
    install(pendingWrite);
    await mount(<ToolAccessPrompt />);
    await arm();
    await click("toolAccess.prompt.approveRead");
    expect(decide).toHaveBeenCalledWith({ requestId: "req-1", decision: "approve", mode: "read" });
  });

  it("denies on Deny and on dismissing the dialog; a read request has no downgrade button", async () => {
    install({ pending: [{ ...pendingWrite.pending[0], mode: "read" }], grants: [] });
    await mount(<ToolAccessPrompt />);
    await arm();
    expect(button("toolAccess.prompt.approveRead")).toBeUndefined();
    await click("toolAccess.prompt.deny");
    expect(decide).toHaveBeenLastCalledWith({ requestId: "req-1", decision: "deny" });

    decide.mockClear();
    await act(async () => pushUpdate(pendingWrite));
    await flush();
    await arm();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(decide).toHaveBeenCalledWith({ requestId: "req-1", decision: "deny" });
  });

  it("keeps every answer disabled for the first second of a request, and Escape does not answer it either", async () => {
    install(pendingWrite);
    await mount(<ToolAccessPrompt />);
    const answers = ["toolAccess.prompt.deny", "toolAccess.prompt.approveRead", "toolAccess.prompt.approve.write"];
    for (const label of answers) expect(button(label)?.disabled, label).toBe(true);
    await click("toolAccess.prompt.approve.write");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(decide).not.toHaveBeenCalled();

    await arm(999);
    for (const label of answers) expect(button(label)?.disabled, label).toBe(true);
    await arm(1);
    for (const label of answers) expect(button(label)?.disabled, label).toBe(false);
  });

  it("starts the wait again when another request takes the place of the one on screen", async () => {
    install(pendingWrite);
    await mount(<ToolAccessPrompt />);
    await arm();
    expect(button("toolAccess.prompt.approve.write")?.disabled).toBe(false);

    // A different tool's request replaces it just as the user is about to click.
    await act(async () => pushUpdate({ pending: [{ ...pendingWrite.pending[0], requestId: "req-2", toolName: "other-tool" }], grants: [] }));
    await flush();
    expect(document.body.textContent).toContain("toolAccess.prompt.title|name=other-tool");
    expect(button("toolAccess.prompt.approve.write")?.disabled).toBe(true);
    await click("toolAccess.prompt.approve.write");
    expect(decide).not.toHaveBeenCalled();

    await arm();
    await click("toolAccess.prompt.approve.write");
    expect(decide).toHaveBeenCalledWith({ requestId: "req-2", decision: "approve" });
  });

  it("renders nothing without the desktop bridge", async () => {
    delete window.sf;
    await mount(<ToolAccessPrompt />);
    expect(container.innerHTML).toBe("");
  });

  it("lists approved tools with mode, grant time and last use, and revokes one on request", async () => {
    install(withGrants);
    await mount(<ConnectedToolsSection />);

    expect(container.textContent).toContain("toolAccess.summary|count=2");
    expect(document.body.querySelectorAll('[data-testid="connected-tool-row"]')).toHaveLength(0);

    await click("toolAccess.viewAll");
    const rows = [...document.body.querySelectorAll('[data-testid="connected-tool-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("backup-tool");
    expect(rows[0].textContent).toContain("toolAccess.mode.read");
    expect(rows[0].textContent).toContain("toolAccess.list.lastUsed");
    expect(rows[1].textContent).toContain("toolAccess.mode.write");
    expect(rows[1].textContent).toContain("toolAccess.list.neverUsed");

    snapshot = { pending: [], grants: [withGrants.grants[1]] };
    await click("toolAccess.list.revoke");
    expect(revoke).toHaveBeenCalledWith("g-1");
    expect(document.body.querySelectorAll('[data-testid="connected-tool-row"]')).toHaveLength(1);
  });

  it("says so when nothing is connected, and shows an error when a revoke is refused", async () => {
    install({ pending: [], grants: [] });
    await mount(<ConnectedToolsSection />);
    expect(container.textContent).toContain("toolAccess.empty");
    await act(async () => root.unmount());
    container.remove();

    install(withGrants);
    revoke.mockResolvedValueOnce({ ok: false });
    await mount(<ConnectedToolsSection />);
    await click("toolAccess.viewAll");
    await click("toolAccess.list.revoke");
    expect(document.body.textContent).toContain("toolAccess.list.revokeError");
  });
});
