/**
 * @test-id error-report-electron-main
 * @level unit
 *
 * The Electron main adapter: init runs once per process, turning reporting off
 * gates everything, and only plain error events may leave through the transport.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ init: [] as any[], sent: [] as any[] }));

vi.mock("@sentry/electron/main", () => ({
  init: (options: unknown) => calls.init.push(options),
  IPCMode: { Classic: 2 },
  makeElectronTransport: () => ({
    send: async (envelope: unknown) => {
      calls.sent.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
}));

import { createElectronMainReporting, onlyErrorEvents } from "../src/electronMain";

const DSN = "https://key@errors.example.test/1";
const APPS = "[badger-desktop]";

beforeEach(() => {
  calls.init.length = 0;
  calls.sent.length = 0;
});

const eventItem = [{ type: "event" }, { message: "x" }];
const replayItem = [{ type: "replay_event" }, { urls: ["/Users/chris/secret"] }];
const attachment = [{ type: "attachment" }, "bytes"];

describe("electron main reporting", () => {
  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} initialises the SDK once, however often the user toggles`, async () => {
    const reporting = createElectronMainReporting({ dsn: DSN, release: "1.0.0" });
    expect(calls.init).toHaveLength(0);
    await reporting.setEnabled(true);
    await reporting.setEnabled(false);
    await reporting.setEnabled(true);
    console.info("[electron-main-test] init calls after on/off/on =", calls.init.length);
    expect(calls.init).toHaveLength(1);
    expect(reporting.isEnabled()).toBe(true);
  });

  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} sends only error events, and nothing at all while off`, async () => {
    const reporting = createElectronMainReporting({ dsn: DSN, release: "1.0.0" });
    await reporting.setEnabled(true);
    const options = calls.init[0];
    const transport = options.transport({});
    const envelope = [{ event_id: "e1" }, [eventItem, replayItem, attachment]];

    await transport.send(envelope);
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0][1]).toEqual([eventItem]);

    await reporting.setEnabled(false);
    await transport.send(envelope);
    console.info("[electron-main-test] sends after opt-out =", calls.sent.length - 1);
    expect(calls.sent).toHaveLength(1);
    expect(options.beforeSend({ message: "x" }, {})).toBeNull();
  });

  // @req REL-LOG-06[badger-desktop]
  it(`@req REL-LOG-06${APPS} keeps working after a failed start`, async () => {
    const reporting = createElectronMainReporting({ dsn: "not a dsn", release: "1.0.0" });
    await reporting.setEnabled(true);
    expect(calls.init).toHaveLength(0);
    await expect(reporting.setEnabled(false)).resolves.toBeUndefined();
  });

  it("drops an envelope with no error event", () => {
    expect(onlyErrorEvents([{}, [replayItem, attachment]] as any)).toBeUndefined();
  });
});
