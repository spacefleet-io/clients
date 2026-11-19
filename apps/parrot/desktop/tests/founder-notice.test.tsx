// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-FOUNDER-NOTICE-001
 * @level unit (real hook, real banner and badge, real React; the bridge to main is a fake)
 * @req WAIT-FOUND-04
 * @why Parrot keeps the session token in main, so the founder status and the notice's seen-mark go through the
 *   bridge (`parrot:account:founder-get`, `parrot:account:founder-notice-seen`). A founder sees the one-time banner and
 *   the settings badge; dismissing hides the banner and asks main to mark it seen. No bridge (a browser preview), no
 *   signed-in account or an unreadable status shows nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FounderBadge, FounderBanner, resetFounderStatusCache } from "@space/ui/founder";
import type { FounderStatusResponse } from "@space/shared/founder";
import type { ParrotBridge } from "../src/shared/ipc";
import { useParrotFounderStatus } from "../src/renderer/src/founder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "parrot-desktop-test:founder-notice";
type FounderBridge = Pick<ParrotBridge, "getFounderStatus" | "markFounderNoticeSeen">;

const FOUNDER: FounderStatusResponse = { founder: true, since: "2026-02-10T08:00:00.000Z", noticePending: true };

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const log = (test: string, step: string, extra: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}] [${test}] ${step}`, { ...extra, html: host.innerHTML.slice(0, 1200) });
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const fakeBridge = (status: FounderStatusResponse | null, seenOk = true) => {
  const getFounderStatus = vi.fn<FounderBridge["getFounderStatus"]>(async () => (status ? { ok: true, status } : { ok: false }));
  const markFounderNoticeSeen = vi.fn<FounderBridge["markFounderNoticeSeen"]>(async () => seenOk);
  return { getFounderStatus, markFounderNoticeSeen };
};

/** What Library (the banner above every page) and Settings ▸ Account (the badge) render. */
function ParrotScreen({ bridge, userId, language }: { bridge: FounderBridge | undefined; userId: string | null; language: string }) {
  const founder = useParrotFounderStatus(bridge, userId);
  return (
    <main>
      <FounderBanner language={language} status={founder.status} onDismiss={founder.dismiss} className="mb-6" />
      <FounderBadge language={language} status={founder.status} />
    </main>
  );
}

const show = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
  await flush();
};

beforeEach(() => {
  resetFounderStatusCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Parrot desktop founder notice", () => {
  it("reads the status through main, shows the banner and badge, and asks main to mark the notice seen", async () => {
    const T = "founder-through-main";
    const bridge = fakeBridge(FOUNDER);
    await show(<ParrotScreen bridge={bridge} userId="u-parrot" language="en" />);
    log(T, "rendered", { reads: bridge.getFounderStatus.mock.calls.length });
    expect(bridge.getFounderStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")?.textContent).toContain("Founder ticket recognised.");
    expect(q("founder-badge")?.textContent).toContain("since the waitlist");

    await act(async () => q("founder-banner-dismiss")!.click());
    await flush();
    log(T, "dismissed", { seen: bridge.markFounderNoticeSeen.mock.calls.length });
    expect(bridge.markFounderNoticeSeen).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();
    expect(q("founder-badge")).not.toBeNull();
  });

  it("keeps the banner hidden when main could not mark it seen (it comes back on the next app start)", async () => {
    const T = "seen-mark-failed";
    const bridge = fakeBridge(FOUNDER, false);
    await show(<ParrotScreen bridge={bridge} userId="u-parrot-2" language="fr" />);
    expect(q("founder-banner")?.querySelector("strong")?.textContent).toBe("Remise fondateur reconnue.");
    await act(async () => q("founder-banner-dismiss")!.click());
    await flush();
    log(T, "dismissed", { seen: bridge.markFounderNoticeSeen.mock.calls.length });
    expect(bridge.markFounderNoticeSeen).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();
  });

  it("shows nothing without a bridge, without an account or when main cannot read the status", async () => {
    const T = "nothing";
    await show(<ParrotScreen bridge={undefined} userId="u-preview" language="en" />);
    log(T, "no bridge");
    expect(q("founder-banner")).toBeNull();

    const signedOut = fakeBridge(FOUNDER);
    await show(<ParrotScreen bridge={signedOut} userId={null} language="en" />);
    log(T, "signed out", { reads: signedOut.getFounderStatus.mock.calls.length });
    expect(signedOut.getFounderStatus).not.toHaveBeenCalled();
    expect(q("founder-banner")).toBeNull();

    const unreadable = fakeBridge(null);
    await show(<ParrotScreen bridge={unreadable} userId="u-parrot-3" language="en" />);
    log(T, "unreadable", { reads: unreadable.getFounderStatus.mock.calls.length });
    expect(unreadable.getFounderStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();
    expect(q("founder-badge")).toBeNull();
  });
});
