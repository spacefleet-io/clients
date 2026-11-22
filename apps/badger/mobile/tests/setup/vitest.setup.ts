/**
 * Runs before every vitest file (vitest.config.ts `setupFiles`). Registers the shared stand-ins so a file that mocks
 * nothing still loads; a file's own `vi.mock` of the same module replaces these, which is why its factory spreads
 * `reactNativeBase()` first (see reactNativeMock.ts). Factories reach the helpers by `import()` because vi.mock is
 * hoisted above static imports.
 */
import { vi } from "vitest";

vi.mock("react-native", async () => (await import("./reactNativeMock")).reactNativeBase());
vi.mock("react-native-svg", async () => (await import("./reactNativeMock")).reactNativeSvgBase());
vi.mock("lucide-react-native", async () => (await import("./reactNativeMock")).lucideBase());

// Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS. The
// player's launching wait (LaunchingMascot) draws the mascot, so every player test loads one.
const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
extensions[".webp"] = (m: { exports: unknown }) => {
  m.exports = 7;
};
// Same-device sign-in (ACCT-PAIR-07) talks to the native SiblingSignIn module: no sister app in a unit test. The
// offer and status have their own tests (login-sibling-offer, auth-sibling-status), which mock this themselves.
vi.mock("@space/mobile-shell/sibling", () => ({
  publishSiblingStatus: async () => undefined,
  getSiblingStatus: async () => null,
}));
vi.mock("@space/mobile-shell/sibling-ui", () => ({
  MobileSiblingOffer: () => null,
  SiblingApprovalScreen: () => null,
}));
