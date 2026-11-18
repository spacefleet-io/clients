import { vi } from "vitest";

/**
 * The profile API that `@/lib/profileStore` binds when it is imported. The playback engine imports it through
 * `@/lib/streamSlot`, so a test that renders the player and mocks `@/api` must spread these into its mock, or the
 * whole file fails at import (`No "listProfiles" export is defined on the "@/api" mock`, #2386 #2387 #2388 #2390).
 * The store calls them only for a signed-in session, so a call here means a test reached the profile flow unexpectedly.
 * Spread it in with `await import()` inside the factory: `vi.mock` factories are hoisted above static imports.
 */
export const profileApiMock = () => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
});
