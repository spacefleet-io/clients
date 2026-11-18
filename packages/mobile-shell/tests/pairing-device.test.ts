/**
 * @test-id MOBILE-SHELL-PAIRING-DEVICE-001
 * @level unit
 * @req ACCT-PAIR-05[badger-mobile,parrot]
 * @why The approver reads "<App> on <name> wants to sign in", so a phone's name must say which app asks and on which
 *   phone: "Parrot (Pixel 8)", never one fixed "Parrot (Android)" for every phone.
 */
import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android", constants: { Model: "Pixel 8" } as Record<string, unknown> }));
vi.mock("react-native", () => ({ Platform: platform }));

import { currentPhoneDeviceName, phoneDeviceName } from "../src/pairing-device";

describe("phone pairing name", () => {
  it("[pair-device-name-1] names the app and the phone model", () => {
    expect(currentPhoneDeviceName("Parrot")).toBe("Parrot (Pixel 8)");
    expect(currentPhoneDeviceName("Badger")).toBe("Badger (Pixel 8)");
    expect(phoneDeviceName("Parrot", "  ")).toBe("Parrot (phone)");
    expect(phoneDeviceName("Parrot", null)).toBe("Parrot (phone)");
  });

  it("[pair-device-name-2] says iPhone on iOS, which does not tell the model", () => {
    platform.OS = "ios";
    platform.constants = {};
    expect(currentPhoneDeviceName("Parrot")).toBe("Parrot (iPhone)");
  });
});
