import { vi, type Mock } from "vitest";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";

export type UpdateRequiredBridgeStub = {
  getAppUpdateRequired: Mock<() => Promise<AppUpdateRequiredPayload | null>>;
  onAppUpdateRequired: Mock<(listener: (payload: AppUpdateRequiredPayload) => void) => () => void>;
};

/**
 * The window bridge's "please update" calls (REL-CD-29) for suites that mount `App` about something else: the API never
 * refused this build, so the update-required gate stays closed. `update-required-gate.test.tsx` drives the real refusal.
 */
export const updateRequiredBridgeStub = (): UpdateRequiredBridgeStub => ({
  getAppUpdateRequired: vi.fn(async (): Promise<AppUpdateRequiredPayload | null> => null),
  onAppUpdateRequired: vi.fn((_listener: (payload: AppUpdateRequiredPayload) => void) => () => undefined),
});
