// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-ROTATION-READINESS-001
 * @level unit
 * @why ACCT-KEYCHG-04: the key-change entries follow the server's `GET /library/recovery/rotate` answer. The hook must
 *   hand back that answer, nothing while signed out or loading, and nothing when the call fails (an entry that could
 *   end in a refusal stays hidden); a new session asks again rather than reuse the previous account's answer.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyRotationReadiness } from "@space/shared/keyChange";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getKeyRotationReadiness: vi.fn() }));
vi.mock("@space/shared/api", () => ({ getKeyRotationReadiness: api.getKeyRotationReadiness }));

import { useKeyRotationReadiness } from "@space/shared/useKeyRotationReadiness";

describe("@req ACCT-KEYCHG-04[badger-desktop] useKeyRotationReadiness", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const seen: Array<KeyRotationReadiness | null> = [];

  const Probe = ({ token }: { token: string | null }) => {
    seen.push(useKeyRotationReadiness(token));
    return null;
  };

  const mount = async (token: string | null) => {
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => root?.render(<Probe token={token} />));
    const last = seen[seen.length - 1] ?? null;
    console.info(`[readiness-hook] token=${token} -> ${JSON.stringify(last)} calls=${api.getKeyRotationReadiness.mock.calls.length}`);
    return last;
  };

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    seen.length = 0;
    api.getKeyRotationReadiness.mockReset();
  });

  it("signed out: no call, nothing offered", async () => {
    expect(await mount(null)).toBeNull();
    expect(api.getKeyRotationReadiness).not.toHaveBeenCalled();
  });

  it("hands back the server's answer for the session", async () => {
    api.getKeyRotationReadiness.mockResolvedValue({ needsMediaReseal: false });
    expect(await mount("tok-a")).toEqual({ needsMediaReseal: false });
    expect(api.getKeyRotationReadiness).toHaveBeenCalledWith("tok-a");
  });

  it("a failed call leaves nothing offered", async () => {
    api.getKeyRotationReadiness.mockRejectedValue(new Error("offline"));
    expect(await mount("tok-a")).toBeNull();
  });

  it("a new session drops the previous answer and asks again", async () => {
    api.getKeyRotationReadiness.mockResolvedValueOnce({ needsMediaReseal: false }).mockReturnValueOnce(new Promise(() => undefined));
    expect(await mount("tok-a")).toEqual({ needsMediaReseal: false });
    expect(await mount("tok-b")).toBeNull();
    expect(api.getKeyRotationReadiness.mock.calls).toEqual([["tok-a"], ["tok-b"]]);
  });
});
