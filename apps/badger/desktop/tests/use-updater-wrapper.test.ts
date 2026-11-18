/**
 * Badger's `useUpdater` is a thin binding of the shared `useDesktopUpdater` (packages/desktop-shell, whose hook
 * behaviour is tested there) to `window.spaceBadger.updater`, with errors routed to the renderer logger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdater } from "@/lib/useUpdater";

// The logger child is created at module load, before the config's clearMocks/mockReset run, so its scope and error
// calls are recorded in plain arrays rather than on spies.
const mocks = vi.hoisted(() => {
  const childScopes: unknown[] = [];
  const errorCalls: unknown[][] = [];
  return {
    useDesktopUpdater: vi.fn(),
    childScopes,
    errorCalls,
    child: (bindings: unknown) => {
      childScopes.push(bindings);
      return { error: (...args: unknown[]) => errorCalls.push(args) };
    },
  };
});

vi.mock("@space/desktop-shell/updater-react", () => ({ useDesktopUpdater: mocks.useDesktopUpdater }));
vi.mock("@/logger", () => ({ rendererLogger: { child: mocks.child } }));

beforeEach(() => {
  mocks.useDesktopUpdater.mockImplementation(() => ({ marker: "controls" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Badger useUpdater wrapper", () => {
  // @req REL-UPD-01
  it("binds window.spaceBadger.updater and logs errors under the updater scope", () => {
    const testId = "use-updater-wrapper:bind";
    const bridge = { check: vi.fn() };
    vi.stubGlobal("window", { spaceBadger: { updater: bridge } });
    console.info(`[${testId}] phase:call`);
    const controls = useUpdater();
    const [passedBridge, onError] = mocks.useDesktopUpdater.mock.calls.at(-1) as unknown as [
      unknown,
      (message: string, context: string) => void,
    ];
    console.info(
      `[${testId}] controls=${JSON.stringify(controls)} bridgeIsSame=${passedBridge === bridge} childScopes=${JSON.stringify(mocks.childScopes)}`,
    );
    expect(controls).toEqual({ marker: "controls" });
    expect(passedBridge).toBe(bridge);
    expect(mocks.childScopes).toEqual([{ scope: "updater" }]);
    onError("boom", "updater check failed");
    expect(mocks.errorCalls).toEqual([[{ message: "boom" }, "updater check failed"]]);
  });

  // @req REL-UPD-01
  it("passes undefined when the bridge is missing", () => {
    const testId = "use-updater-wrapper:no-bridge";
    vi.stubGlobal("window", {});
    useUpdater();
    const passedBridge = (mocks.useDesktopUpdater.mock.calls.at(-1) as unknown as unknown[])[0];
    console.info(`[${testId}] passedBridge=${String(passedBridge)}`);
    expect(passedBridge).toBeUndefined();
  });
});
