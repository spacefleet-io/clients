/**
 * PLAT-WEB-05: the `badger://` link starts (or reaches) Badger in the background on every OS: the link is found in
 * the command line however each OS / launcher shapes it (Windows exe, Linux binary, dev Electron with switches,
 * quoted), the first window stays hidden, macOS `activate` right after a link does not show it, and a running
 * instance reached through a link stays in the background.
 */
import { describe, expect, it, vi } from "vitest";
import { createProviderReturnMailbox, PROVIDER_RETURN_TTL_MS } from "@space/shared/providerSignIn";
import type { AppLink } from "@space/desktop-shell/main-shell";
import { badgerLinks, decideLaunchVisibility, LINK_ACTIVATE_GRACE_MS, shouldShowOnActivate } from "../src/main/protocolLink";
import { handleSecondInstance } from "../src/main/secondInstanceHandler";

/** What the shared classifier made of a link, shaped like the old per-app helpers for a short expectation. */
const paymentReturnOf = (link: string): string | null => {
  const classified: AppLink = badgerLinks.classify(link);
  return classified.kind === "payment-return" ? classified.paymentId : null;
};
const providerReturnOf = (link: string) => {
  const found = badgerLinks.fromArgv([link]);
  return found?.kind === "provider-return" ? found.outcome : null;
};

const dump = (label: string, value: unknown) => console.info(`[protocol-link:${label}] state`, JSON.stringify(value));

describe("badgerLinks.find", () => {
  const cases: Array<{ name: string; argv: unknown[]; expected: string | null }> = [
    { name: "windows packaged", argv: ["C:\\Program Files\\SpaceBadger\\Badger.exe", "badger://start"], expected: "badger://start" },
    { name: "linux packaged", argv: ["/opt/SpaceBadger/spacebadger", "badger://start"], expected: "badger://start" },
    {
      name: "dev electron, switches before the link",
      argv: ["/x/node_modules/electron/dist/electron", "/x/out/main/index.js", "--allow-file-access-from-files", "badger://start"],
      expected: "badger://start",
    },
    { name: "quoted (windows shell)", argv: ["Badger.exe", '"badger://start"'], expected: "badger://start" },
    { name: "uppercase scheme", argv: ["spacebadger", "BADGER://start"], expected: "BADGER://start" },
    { name: "no link", argv: ["spacebadger", "--inspect", "/home/u/badger"], expected: null },
    { name: "non-string entries", argv: [undefined, 42, null, { href: "badger://x" }], expected: null },
  ];
  for (const testCase of cases) {
    // @req PLAT-WEB-05
    it(`finds the link: ${testCase.name}`, () => {
      const found = badgerLinks.find(testCase.argv);
      dump("find", { name: testCase.name, found });
      expect(found).toBe(testCase.expected);
    });
  }
});

describe("decideLaunchVisibility", () => {
  // @req PLAT-WEB-05
  it("starts in the background through a link (argv or macOS open-url), in the foreground otherwise", () => {
    const results = {
      argv: decideLaunchVisibility({ argv: ["spacebadger", "badger://start"], openUrlBeforeWindow: false }),
      openUrl: decideLaunchVisibility({ argv: ["/Applications/SpaceBadger.app/Contents/MacOS/SpaceBadger"], openUrlBeforeWindow: true }),
      plain: decideLaunchVisibility({ argv: ["spacebadger"], openUrlBeforeWindow: false }),
    };
    dump("visibility", results);
    expect(results).toEqual({ argv: "background", openUrl: "background", plain: "foreground" });
  });

  // @req ACCT-PAY-05
  it("starts in the foreground through a payment return link, the user is coming back to Badger", () => {
    const link = "badger://billing/return?payment=6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const results = {
      paymentId: paymentReturnOf(link),
      start: paymentReturnOf("badger://start"),
      otherApp: paymentReturnOf("parrot://billing/return?payment=6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"),
      badId: paymentReturnOf("badger://billing/return?payment=../x"),
      visibility: decideLaunchVisibility({ argv: ["spacebadger", "--no-sandbox", link], openUrlBeforeWindow: false }),
    };
    dump("payment-return", results);
    expect(results).toEqual({
      paymentId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      start: null,
      otherApp: null,
      badId: null,
      visibility: "foreground",
    });
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] reads the provider return link and starts in the foreground through it", () => {
    const code = "AbCdEfGhIjKlMnOpQrStUv_-0123";
    const link = `badger://auth/provider?signinCode=${code}`;
    const results = {
      code: providerReturnOf(link),
      quoted: providerReturnOf(`"${link}"`),
      error: providerReturnOf("badger://auth/provider?signinError=email_unverified"),
      unknownError: providerReturnOf("badger://auth/provider?signinError=boom"),
      badCode: providerReturnOf("badger://auth/provider?signinCode=short"),
      empty: providerReturnOf("badger://auth/provider"),
      otherPath: providerReturnOf(`badger://auth/other?signinCode=${code}`),
      otherApp: providerReturnOf(`parrot://auth/provider?signinCode=${code}`),
      start: providerReturnOf("badger://start"),
      visibility: decideLaunchVisibility({ argv: ["spacebadger", link], openUrlBeforeWindow: false }),
    };
    dump("provider-return", results);
    expect(results).toEqual({
      code: { code },
      quoted: { code },
      error: { error: "email_unverified" },
      unknownError: { error: "provider_failed" },
      badCode: { error: "invalid_code" },
      empty: { error: "invalid_code" },
      otherPath: null,
      otherApp: null,
      start: null,
      visibility: "foreground",
    });
  });
});

describe("createProviderReturnMailbox", () => {
  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] hands each outcome over once, and nothing once the code has expired", () => {
    let clock = 1_000;
    const mailbox = createProviderReturnMailbox(() => clock);
    const results: unknown[] = [mailbox.take()];
    mailbox.put({ code: "first-code-0123456789" });
    mailbox.put({ code: "second-code-0123456789" });
    results.push(mailbox.take(), mailbox.take());
    mailbox.put({ error: "cancelled" });
    clock += PROVIDER_RETURN_TTL_MS + 1;
    results.push(mailbox.take());
    dump("mailbox", results);
    expect(results).toEqual([null, { code: "second-code-0123456789" }, null, null]);
  });
});

describe("shouldShowOnActivate", () => {
  // @req PLAT-WEB-05
  it("does not show the window on a macOS activate that follows a link", () => {
    const results = {
      noLink: shouldShowOnActivate({ now: 10_000, lastLinkAt: null }),
      justAfterLink: shouldShowOnActivate({ now: 10_000, lastLinkAt: 10_000 - LINK_ACTIVATE_GRACE_MS }),
      later: shouldShowOnActivate({ now: 10_000, lastLinkAt: 10_000 - LINK_ACTIVATE_GRACE_MS - 1 }),
    };
    dump("activate", results);
    expect(results).toEqual({ noLink: true, justAfterLink: false, later: true });
  });
});

describe("second-instance with a link", () => {
  // @req PLAT-WEB-05
  it("hands the link over without showing the running app; a plain second launch still shows it", () => {
    const showMainWindow = vi.fn();
    const requestQuit = vi.fn();
    const onLink = vi.fn();
    const deps = { showMainWindow, requestQuit, getWindowProcessingState: () => "idle" as const, onLink };

    console.info("[protocol-link:second-instance] phase: launch with link");
    handleSecondInstance({ ...deps, argv: ["Badger.exe", "--flag", "badger://start"] });
    dump("second-instance-link", { show: showMainWindow.mock.calls.length, links: onLink.mock.calls });
    expect(onLink).toHaveBeenCalledWith("badger://start");
    expect(showMainWindow).not.toHaveBeenCalled();

    console.info("[protocol-link:second-instance] phase: plain launch");
    handleSecondInstance({ ...deps, argv: ["Badger.exe"] });
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(requestQuit).not.toHaveBeenCalled();
  });
});
