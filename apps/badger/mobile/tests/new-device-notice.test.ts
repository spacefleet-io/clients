import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { diffNewSessions, newDeviceMessage, parseNewDevicePush } from "../src/lib/pairing/newDevice";

// The approve flow itself is shared by the phone apps: packages/mobile-shell/tests/pairing-approve-flow.test.ts.

beforeAll(async () => {
  await initI18n("en");
});

describe("new device notice", () => {
  // @req ACCT-PAIR-03
  it("reads the new-device push from Firebase `data` and from a flat APNs payload", () => {
    const fcm = {
      notification: { title: "New device added" },
      data: { kind: "new_device", sessionId: "s1", deviceName: "Den TV", deviceType: "tv" },
    };
    expect(parseNewDevicePush(fcm)).toEqual({ sessionId: "s1", deviceName: "Den TV", deviceType: "tv" });
    expect(parseNewDevicePush({ kind: "new_device", deviceName: "Box", deviceType: "kodi" })).toMatchObject({
      deviceName: "Box",
    });
    expect(parseNewDevicePush({ data: { kind: "library_changed" } })).toBeNull();
    expect(parseNewDevicePush(null)).toBeNull();
    expect(newDeviceMessage({ deviceName: "Den TV", deviceType: "tv" })).toBe("New device added: Den TV (TV)");
  });

  // @req ACCT-PAIR-03
  it("announces sessions that appeared since the last look, never this phone's own or the first list", () => {
    const sessions = [
      { id: "a", current: true, clientType: "client-mobile" },
      { id: "b", deviceName: "Den TV", deviceType: "tv" },
      { id: "c", clientType: "badger-kodi" },
    ];
    expect(diffNewSessions(null, sessions)).toEqual([]);
    expect(diffNewSessions(["a", "b"], sessions)).toEqual([{ sessionId: "c", deviceName: "Kodi", deviceType: "kodi" }]);
    expect(diffNewSessions(["a", "b", "c"], sessions)).toEqual([]);
  });
});
