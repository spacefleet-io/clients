// @vitest-environment jsdom
/**
 * @level unit
 * @req UX-NOTICE-08: a lasting account state is a compact chip in the top bar's status slot: one or two words on
 *   screen, the whole notice in its label and tooltip; a button when it opens a place, a status when it only informs.
 * @req ACCT-UNPAID-06[badger-desktop] ACCT-UNPAID-06[parrot]: in place of the library step, an unpaid account reads
 *   that its plan has ended and that the library can be set up once it is renewed, with Renew and Try again.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusChip } from "../src/components/desktop-status-chip";
import { DesktopUnpaidSetupStep } from "../src/components/desktop-unpaid-setup-step";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[desktop-shell:unpaid-pieces]";
let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("DesktopStatusChip", () => {
  it("only informs without onClick: a status carrying the whole notice", async () => {
    await render(<DesktopStatusChip testId="sign" sign="Plan ended" message="Your subscription ended." data={{ "data-wipe-at": "2027-01-22" }} />);
    const chip = q("sign")!;
    console.info(SUITE, "inform", chip.outerHTML);
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("role")).toBe("status");
    expect(chip.getAttribute("aria-label")).toBe("Your subscription ended.");
    expect(chip.getAttribute("title")).toBe("Your subscription ended.");
    expect(chip.getAttribute("data-wipe-at")).toBe("2027-01-22");
    expect(chip.textContent).toBe("Plan ended");
  });

  it("is a button that opens its place with onClick, and keeps a trailing control beside it", async () => {
    const onClick = vi.fn();
    await render(<DesktopStatusChip testId="sign" sign="Over storage" message="Over storage." onClick={onClick} trailing={<button data-testid="dismiss">x</button>} />);
    console.info(SUITE, "button", host.innerHTML);
    expect(q("sign")!.tagName).toBe("BUTTON");
    expect(q("dismiss")).not.toBeNull();
    await act(async () => q("sign")!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopUnpaidSetupStep", () => {
  it("says the plan ended in the app's words, offers Renew and Try again, and shows the outcome", async () => {
    const onRenew = vi.fn();
    const onTryAgain = vi.fn();
    await render(<DesktopUnpaidSetupStep language="en" app="badger" onRenew={onRenew} onTryAgain={onTryAgain} message="Your plan is not renewed yet." />);
    console.info(SUITE, "step", host.textContent);
    expect(host.querySelector("h1")?.textContent).toBe("Your plan has ended");
    expect(host.textContent).toContain("Your media library can be set up once your plan is renewed.");
    expect(q("unpaid-setup-message")?.textContent).toBe("Your plan is not renewed yet.");
    await act(async () => q("unpaid-setup-renew")!.click());
    await act(async () => q("unpaid-setup-try-again")!.click());
    expect(onRenew).toHaveBeenCalledTimes(1);
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("holds both buttons while renewing and uses Parrot's word for the library in French", async () => {
    await render(<DesktopUnpaidSetupStep language="fr" app="parrot" onRenew={() => undefined} onTryAgain={() => undefined} renewing />);
    console.info(SUITE, "renewing", host.textContent);
    expect(host.textContent).toContain("Votre bibliothèque pourra être créée");
    expect(q("unpaid-setup-renew")?.textContent).toBe("Renouvellement…");
    expect(q("unpaid-setup-renew")?.hasAttribute("disabled")).toBe(true);
    expect(q("unpaid-setup-try-again")?.hasAttribute("disabled")).toBe(true);
  });
});
