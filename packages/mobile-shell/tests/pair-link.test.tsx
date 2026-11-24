/**
 * @test-id MOBILE-SHELL-PAIR-LINK-001
 * @level unit
 * @why ACCT-PAIR-06: a pairing link scanned with the system camera opens the app's approve screen with the code, even
 *   when it arrives before the user is signed in or before the navigator exists. Badger and Parrot each had their own
 *   intake (quality audit #3350 S21); both now use this one, Badger also reading the old `spacebadger://pair` link.
 *   Rendered with react-test-renderer; react-native's Linking is a stand-in.
 *
 * @req ACCT-PAIR-06[badger-mobile]
 * @req ACCT-PAIR-06[parrot]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  initialUrl: null as string | null,
  urlListener: null as ((event: { url: string }) => void) | null,
  providerReturns: [] as string[],
}));

vi.mock("react-native", () => ({
  Linking: {
    getInitialURL: async () => h.initialUrl,
    addEventListener: (_: "url", listener: (event: { url: string }) => void) => {
      h.urlListener = listener;
      return { remove: () => void (h.urlListener = null) };
    },
  },
}));
vi.mock("../src/provider-sign-in", () => ({
  handOffProviderReturn: (scheme: string, url: string | null | undefined) => {
    if (!url?.startsWith(`${scheme}://auth/provider`)) return false;
    h.providerReturns.push(url);
    return true;
  },
}));

import { createPendingPairLink, type PendingPairLink } from "../src/pairing-approve/pairLink";
import { useHeldPairLink, usePairLinkIntake } from "../src/pairing-approve/usePairLinks";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const Intake = ({ pending, ready, open }: { pending: PendingPairLink; ready: boolean; open: (code: string) => void }) => {
  usePairLinkIntake("parrot", pending);
  useHeldPairLink(pending, ready, open);
  return null;
};

afterEach(() => {
  h.initialUrl = null;
  h.urlListener = null;
  h.providerReturns.length = 0;
});

describe("the phones' pairing-link intake (ACCT-PAIR-06, #3350 S21)", () => {
  it("[pair-link-1] holds a pairing link's code until taken, once; either app's link is held (ACCT-PAIR-05)", () => {
    const pending = createPendingPairLink();
    const seen = vi.fn();
    const stop = pending.onHeld(seen);
    expect(pending.hold("https://spacefleet.io/pair/parrot?code=abcd-efgh")).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(pending.take()).toBe("ABCDEFGH");
    expect(pending.take()).toBeNull();
    expect(pending.hold("https://spacefleet.io/pair/badger?code=ABCD-EFGH")).toBe(true);
    expect(pending.take()).toBe("ABCDEFGH");
    stop();
    for (const url of ["parrot://auth/provider?signinCode=x", "https://spacefleet.io/en/downloads", "spacebadger://pair?code=ABCDEFGH", null]) {
      expect(pending.hold(url)).toBe(false);
    }
    expect(pending.take()).toBeNull();
  });

  it("[pair-link-2] the old spacebadger://pair link is read only when the app asks for it (Badger, until REL-CD-08)", () => {
    const badger = createPendingPairLink({ legacy: true });
    expect(badger.hold("spacebadger://pair?code=ABCD-EFGH")).toBe(true);
    expect(badger.take()).toBe("ABCDEFGH");
    expect(createPendingPairLink().hold("spacebadger://pair?code=ABCD-EFGH")).toBe(false);
  });

  it("[pair-link-3] a cold-start link waits until the app is ready, then opens the approve screen once", async () => {
    h.initialUrl = "https://spacefleet.io/pair/parrot?code=ABCD-EFGH";
    const pending = createPendingPairLink();
    const open = vi.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Intake pending={pending} ready={false} open={open} />);
    });
    expect(open).not.toHaveBeenCalled();
    await act(async () => tree.update(<Intake pending={pending} ready open={open} />));
    expect(open).toHaveBeenCalledWith("ABCDEFGH");
    await act(async () => tree.update(<Intake pending={pending} ready={false} open={open} />));
    await act(async () => tree.update(<Intake pending={pending} ready open={open} />));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("[pair-link-4] a link arriving while ready opens at once; a sign-in return goes to the sign-in screen instead", async () => {
    const pending = createPendingPairLink();
    const open = vi.fn();
    await act(async () => {
      create(<Intake pending={pending} ready open={open} />);
    });
    await act(async () => h.urlListener?.({ url: "parrot://auth/provider?signinCode=x" }));
    expect(h.providerReturns).toEqual(["parrot://auth/provider?signinCode=x"]);
    expect(open).not.toHaveBeenCalled();
    await act(async () => h.urlListener?.({ url: "https://spacefleet.io/pair/parrot?code=WXYZ-2345" }));
    expect(open).toHaveBeenCalledWith("WXYZ2345");
    expect(pending.take()).toBeNull();
  });
});
