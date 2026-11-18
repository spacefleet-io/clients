/**
 * @test-id error-report-react-native
 * @level unit
 *
 * The React Native adapter: `Sentry.close()` waits for unsent reports before it
 * shuts the client down, so the adapter must stop passing events on the moment
 * the user turns reporting off, not when `close()` settles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@sentry/react-native", () => sdk);

import { createReactNativeReporting } from "../src/reactNative";

const DSN = "https://key@errors.example.test/2";
const event = { event_id: "abcdef0123456789abcdef0123456789", platform: "javascript", level: "error", message: "boom" };

beforeEach(() => {
  sdk.init.mockReset();
  sdk.close.mockReset();
  sdk.close.mockResolvedValue(true);
});

describe("react native reporting", () => {
  // @req REL-LOG-06[badger-mobile]
  it(`@req REL-LOG-06[badger-mobile] drops an event captured while close() is still pending`, async () => {
    let finishClose: (value: boolean) => void = () => {};
    sdk.close.mockReturnValue(new Promise<boolean>((resolve) => (finishClose = resolve)));

    const reporting = createReactNativeReporting({ dsn: DSN, release: "1.0.0" });
    await reporting.setEnabled(true);
    const options = sdk.init.mock.calls[0][0];
    console.info("[rn-test] native half off:", options.enableNative === false && options.enableNativeCrashHandling === false);
    expect(options.beforeSend(event, {})).not.toBeNull();

    const stopping = reporting.setEnabled(false);
    // `stop()` runs on a later microtask turn; let it start, then leave `close()` pending.
    await vi.waitFor(() => expect(sdk.close).toHaveBeenCalledTimes(1));
    const duringClose = options.beforeSend(event, {});
    console.info("[rn-test] event while close() pending ->", duringClose);
    expect(duringClose).toBeNull();
    expect(reporting.isEnabled()).toBe(true);

    finishClose(true);
    await stopping;
    expect(reporting.isEnabled()).toBe(false);
    expect(options.beforeSend(event, {})).toBeNull();
  });

  // @req REL-LOG-06[badger-mobile]
  it(`@req REL-LOG-06[badger-mobile] stays silent before the first opt-in and passes events again after a second one`, async () => {
    const reporting = createReactNativeReporting({ dsn: DSN, release: "1.0.0" });
    expect(sdk.init).not.toHaveBeenCalled();
    await reporting.setEnabled(true);
    await reporting.setEnabled(false);
    await reporting.setEnabled(true);
    console.info("[rn-test] init calls after on/off/on =", sdk.init.mock.calls.length);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(sdk.init.mock.calls[1][0].beforeSend(event, {})).not.toBeNull();
  });

  // @req REL-LOG-06[badger-mobile]
  it(`@req REL-LOG-06[badger-mobile] never starts the SDK for a build without a valid DSN`, async () => {
    const reporting = createReactNativeReporting({ dsn: "", release: "1.0.0" });
    await reporting.setEnabled(true);
    expect(sdk.init).not.toHaveBeenCalled();
  });
});
