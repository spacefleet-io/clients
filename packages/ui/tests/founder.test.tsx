// @vitest-environment jsdom
/**
 * @test-id UI-FOUNDER-NOTICE-001
 * @level unit (real hook, real React; the founder routes are a fake source)
 * @req WAIT-FOUND-04
 * @req WAIT-FOUND-03
 * @why Every signed-in client (web, Badger and Parrot on desktop) shows the one-time "Founder ticket recognised"
 *   banner while `GET /account/founder` says `noticePending`, and the "Founder 🎫 · since the waitlist, {date}" badge
 *   while `founder`. Dismissing hides the banner at once, marks the notice seen on the server (so no device shows it
 *   again) and keeps it hidden across remounts and later reads. The status is read at start and again when the window
 *   comes back, throttled. An unverified account (`founder: false`) sees nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FounderStatusResponse } from "@space/shared/founder";
import { FounderBadge, FounderBanner, resetFounderStatusCache, useFounderStatus, type FounderStatusSource } from "../src/founder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "ui-test:founder";
const PENDING: FounderStatusResponse = { founder: true, since: "2026-03-04T10:00:00.000Z", noticePending: true };
const SEEN: FounderStatusResponse = { ...PENDING, noticePending: false };
const UNVERIFIED: FounderStatusResponse = { founder: false, since: null, noticePending: false };

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const log = (test: string, step: string, extra: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}] [${test}] ${step}`, { ...extra, html: host.innerHTML.slice(0, 1200) });
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const fakeSource = (key: string, answers: Array<FounderStatusResponse | null | Error>) => {
  const getStatus = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const markSeen = vi.fn(async () => undefined);
  return { key, getStatus, markSeen } satisfies FounderStatusSource;
};

/** The two places an app puts the status: the banner above the page and the badge in account settings. */
function Screen({ source, language, refocusMs }: { source: FounderStatusSource | null; language: string; refocusMs?: number }) {
  const founder = useFounderStatus(source, refocusMs);
  return (
    <div>
      <FounderBanner language={language} status={founder.status} onDismiss={founder.dismiss} />
      <FounderBadge language={language} status={founder.status} />
    </div>
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
  vi.useRealTimers();
});

describe("founder banner and badge", () => {
  it("shows the one-time banner and the badge in English, then dismisses: hidden at once and marked seen", async () => {
    const T = "banner-dismiss-en";
    const source = fakeSource("tok-1", [PENDING]);
    await show(<Screen source={source} language="en" />);
    log(T, "rendered", { reads: source.getStatus.mock.calls.length });
    expect(source.getStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")?.textContent).toContain("🎫");
    expect(q("founder-banner")?.querySelector("strong")?.textContent).toBe("Founder ticket recognised.");
    expect(q("founder-banner")?.getAttribute("role")).toBe("status");
    expect(q("founder-badge")?.textContent).toContain("Founder");
    expect(q("founder-badge")?.textContent).toContain("🎫");
    expect(q("founder-badge")?.textContent).toContain("since the waitlist");

    await act(async () => q("founder-banner-dismiss")!.click());
    await flush();
    log(T, "dismissed", { seen: source.markSeen.mock.calls.length });
    expect(q("founder-banner")).toBeNull();
    expect(source.markSeen).toHaveBeenCalledTimes(1);
    // The badge stays: the account is still a founder.
    expect(q("founder-badge")).not.toBeNull();
  });

  it("speaks French and never says 'formule', a deadline or a seat count", async () => {
    const T = "banner-fr";
    const source = fakeSource("tok-fr", [PENDING]);
    await show(<Screen source={source} language="fr" />);
    const text = host.textContent ?? "";
    log(T, "rendered", { text });
    expect(q("founder-banner")?.querySelector("strong")?.textContent).toBe("Ticket fondateur reconnu.");
    expect(q("founder-badge")?.textContent).toContain("depuis la liste d'attente");
    expect(text).not.toMatch(/formule|300|7 jours/i);
  });

  it("puts the date on its own line, without the separator, in the stacked layout", async () => {
    const T = "badge-stacked";
    await show(<FounderBadge language="en" status={SEEN} layout="stacked" />);
    const lines = [...q("founder-badge")!.children].map((el) => el.textContent);
    log(T, "rendered", { lines });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Founder");
    expect(lines[1]).toMatch(/^since the waitlist, /);
    expect(q("founder-badge")?.textContent).not.toContain("·");
  });

  it("shows nothing for an unverified or non-founder account (WAIT-FOUND-03), nor while the API is unreachable", async () => {
    const T = "nothing-before-verification";
    const unverified = fakeSource("tok-unverified", [UNVERIFIED]);
    await show(<Screen source={unverified} language="en" />);
    log(T, "unverified");
    expect(q("founder-banner")).toBeNull();
    expect(q("founder-badge")).toBeNull();

    const down = fakeSource("tok-down", [new Error("network down")]);
    await show(<Screen source={down} language="en" />);
    log(T, "api down", { reads: down.getStatus.mock.calls.length });
    expect(down.getStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();

    await show(<Screen source={null} language="en" />);
    log(T, "signed out");
    expect(host.textContent).toBe("");
  });

  it("keeps a dismissed banner hidden across a remount and a later read that still says pending", async () => {
    const T = "dismiss-sticks";
    const source = fakeSource("tok-2", [PENDING]);
    await show(<Screen source={source} language="en" refocusMs={0} />);
    await act(async () => q("founder-banner-dismiss")!.click());
    await flush();
    log(T, "dismissed");
    // A new page mounts the banner again (Badger's top bar); the server may not have seen the mark yet.
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(<Screen source={source} language="en" refocusMs={0} />);
    log(T, "remounted", { reads: source.getStatus.mock.calls.length });
    expect(source.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(q("founder-banner")).toBeNull();
    expect(q("founder-badge")).not.toBeNull();
  });

  it("reads again when the window comes back, at most once per throttle window, and after a sign-in", async () => {
    const T = "refocus";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    const source = fakeSource("tok-3", [SEEN, PENDING]);
    await show(<Screen source={source} language="en" refocusMs={60_000} />);
    log(T, "start", { reads: source.getStatus.mock.calls.length });
    expect(source.getStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();

    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    log(T, "focus inside the throttle", { reads: source.getStatus.mock.calls.length });
    expect(source.getStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-18T10:01:01Z"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    log(T, "focus after the throttle", { reads: source.getStatus.mock.calls.length });
    expect(source.getStatus).toHaveBeenCalledTimes(2);
    // The account was claimed meanwhile (e.g. verified on another device): the banner appears.
    expect(q("founder-banner")).not.toBeNull();

    const other = fakeSource("tok-4", [UNVERIFIED]);
    await show(<Screen source={other} language="en" refocusMs={60_000} />);
    log(T, "signed in as someone else", { reads: other.getStatus.mock.calls.length });
    expect(other.getStatus).toHaveBeenCalledTimes(1);
    expect(q("founder-banner")).toBeNull();
    expect(q("founder-badge")).toBeNull();
  });
});
