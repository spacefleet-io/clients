/**
 * @test-id TV-PAIR-VERIFYKEY-001
 * @level unit
 * @why After approval the TV checks the library key it received against the account's key probe BEFORE storing it.
 *   quick-crypto reports a wrong key as a generic "unable to authenticate data" error, so every failure to open
 *   the probe must read as a mismatch: otherwise a wrong key is stored and the library never decrypts.
 *   Runs the shared key check (`@space/mobile-shell/pairing`, also Parrot's) with the TV's options and the real
 *   AES-GCM code of src/lib/crypto.ts over node's crypto.
 */
import nodeCrypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPairingKeyCheck } from "@space/mobile-shell/pairing";
// vi.mock calls below are hoisted above these imports, so both modules load with the mocks in place.
import { TV_PAIRING_RUNTIME } from "./pairingRuntime";
import { encryptBytesToBase64 } from "../../lib/crypto";

const ctl = vi.hoisted(() => ({
  meta: null as { exists: boolean; keyProbe?: string | null } | null,
  metaError: null as Error | null,
  library: null as string | null,
}));

vi.mock("react-native-quick-crypto", () => ({ default: nodeCrypto }));
vi.mock("react-native", async () => ({ ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(), Platform: { isTV: true, OS: "android", constants: {} } }));
vi.mock("../../lib/onboarding", () => ({ setLibraryKeyAcknowledged: async () => undefined, setStoredLibraryKey: async () => undefined }));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/shared/api")>();
  return {
    ...actual,
    getLibraryMeta: async (_token: string, library: string) => {
      ctl.library = library;
      if (ctl.metaError) throw ctl.metaError;
      return ctl.meta;
    },
  };
});

const verifyKey = createPairingKeyCheck(TV_PAIRING_RUNTIME);

const keyOf = (fill: number) => Buffer.alloc(32, fill).toString("base64");

beforeEach(() => {
  ctl.meta = null;
  ctl.metaError = null;
  ctl.library = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("TV pairing key verification", () => {
  it("accepts the key that encrypted the probe", async () => {
    console.info("[tv-verifykey:phase] same key");
    ctl.meta = { exists: true, keyProbe: await encryptBytesToBase64(keyOf(1), new TextEncoder().encode("probe")) };
    expect(await verifyKey("tok", keyOf(1))).toBe("ok");
    // The TV checks against Badger's library, not Parrot's.
    expect(ctl.library).toBe("badger");
  });

  it("reads a different key as a mismatch whatever error the crypto library throws", async () => {
    console.info("[tv-verifykey:phase] other key");
    ctl.meta = { exists: true, keyProbe: await encryptBytesToBase64(keyOf(1), new TextEncoder().encode("probe")) };
    const result = await verifyKey("tok", keyOf(2));
    console.info("[tv-verifykey:state]", { result, warned: vi.mocked(console.warn).mock.calls.length });
    expect(result).toBe("mismatch");
  });

  it("reads a corrupt probe or an unusable key as a mismatch too", async () => {
    ctl.meta = { exists: true, keyProbe: Buffer.alloc(64, 7).toString("base64") };
    expect(await verifyKey("tok", keyOf(1))).toBe("mismatch");
    ctl.meta = { exists: true, keyProbe: await encryptBytesToBase64(keyOf(1), new Uint8Array([1])) };
    expect(await verifyKey("tok", "not-a-key")).toBe("mismatch");
  });

  it("cannot check when there is no library yet, no probe, or the API is unreachable", async () => {
    ctl.meta = { exists: false };
    expect(await verifyKey("tok", keyOf(1))).toBe("unchecked");
    ctl.meta = { exists: true, keyProbe: null };
    expect(await verifyKey("tok", keyOf(1))).toBe("unchecked");
    ctl.metaError = new TypeError("Network request failed");
    expect(await verifyKey("tok", keyOf(1))).toBe("unchecked");
  });
});
