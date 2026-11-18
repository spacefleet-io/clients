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
