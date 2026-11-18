import { afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup, screen } from "@testing-library/react";
import { useSignOutWithKeyCheck, type SignOutKeyCheckText } from "@space/ui";

// @req ACCT-DEV-03 — shared desktop saved-key question before the user's own Sign out.

const TEXT: SignOutKeyCheckText = {
  title: "Did you save your key?",
  body: "Without it, the only way back in is typing it.",
  cancel: "Cancel",
  confirm: "I saved it, sign out",
  showKey: "Show my key",
};

function Harness(props: { holdsKey: boolean; signOut: () => Promise<void>; onShowKey?: () => void }) {
  const { requestSignOut, dialog } = useSignOutWithKeyCheck({
    holdsKey: () => props.holdsKey,
    signOut: props.signOut,
    text: TEXT,
    onShowKey: props.onShowKey,
    log: (event) => console.info(`[sign-out-key-check:test] event=${event}`),
  });
  return (
    <>
      <button type="button" onClick={() => void requestSignOut()}>
        Sign out
      </button>
      {dialog}
    </>
  );
}

afterEach(cleanup);

describe("useSignOutWithKeyCheck (ACCT-DEV-03)", () => {
  it("[sign-out-key-check:no-key] signs out at once without a key", async () => {
    const signOut = vi.fn(async () => {});
    render(<Harness holdsKey={false} signOut={signOut} />);
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    console.info(`[sign-out-key-check:no-key] dialog=${screen.queryByTestId("sign-out-key-check") !== null}`);
    expect(screen.queryByTestId("sign-out-key-check")).toBeNull();
  });

  it("[sign-out-key-check:cancel] asks when the key is held; Cancel is focused and changes nothing", async () => {
    const signOut = vi.fn(async () => {});
    render(<Harness holdsKey signOut={signOut} />);
    fireEvent.click(screen.getByText("Sign out"));
    const dialog = await screen.findByTestId("sign-out-key-check");
    console.info(`[sign-out-key-check:cancel] dialog text="${dialog.textContent}"`);
    expect(screen.getByText(TEXT.title)).toBeTruthy();
    expect(screen.queryByText(TEXT.showKey!)).toBeNull();
    const cancel = screen.getByText(TEXT.cancel);
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByTestId("sign-out-key-check")).toBeNull());
    expect(signOut).not.toHaveBeenCalled();
  });

  it("[sign-out-key-check:confirm] signs out only after the confirm", async () => {
    const signOut = vi.fn(async () => {});
    render(<Harness holdsKey signOut={signOut} />);
    fireEvent.click(screen.getByText("Sign out"));
    fireEvent.click(await screen.findByText(TEXT.confirm));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    console.info(`[sign-out-key-check:confirm] signOut calls=${signOut.mock.calls.length}`);
  });

  it("[sign-out-key-check:show-key] offers Show my key only with a handler, which does not sign out", async () => {
    const signOut = vi.fn(async () => {});
    const onShowKey = vi.fn();
    render(<Harness holdsKey signOut={signOut} onShowKey={onShowKey} />);
    fireEvent.click(screen.getByText("Sign out"));
    fireEvent.click(await screen.findByText(TEXT.showKey!));
    console.info(`[sign-out-key-check:show-key] onShowKey calls=${onShowKey.mock.calls.length}`);
    expect(onShowKey).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });
});
