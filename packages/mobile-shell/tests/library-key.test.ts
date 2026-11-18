/**
 * @test-id MOBILE-SHELL-LIBRARY-KEY-001
 * @level unit
 * @why Badger and Parrot share one library key per account (PLAT-SUITE-02). The phone keeps it in the keychain
 *   under one service, and a typed key is checked against the account's keyProbe before it is kept. These tests pin
 *   the keychain/storage contract both apps rely on and the four outcomes of the key check.
 */
import nodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  checkLibraryKey,
  createLibraryKeyStore,
  isLibraryKeyShape,
  LIBRARY_KEY_ACK_STORAGE,
  LIBRARY_KEY_SERVICE,
  normalizeLibraryKey,
} from "../src/libraryKey";
import { generateLibraryKeyWords, readLibraryKeyInput } from "@space/shared/libraryKeyWords";

const memoryKeychain = () => {
  const items = new Map<string, string>();
  return {
    items,
    getGenericPassword: async ({ service }: { service: string }) =>
      items.has(service) ? { password: items.get(service)! } : (false as const),
    setGenericPassword: async (_user: string, password: string, { service }: { service: string }) => {
      items.set(service, password);
    },
    resetGenericPassword: async ({ service }: { service: string }) => {
      items.delete(service);
    },
  };
};

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
  };
};

const aesGcmOpen = async (keyBase64: string, payloadBase64: string) => {
  const payload = Buffer.from(payloadBase64, "base64");
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([decipher.update(payload.subarray(12, payload.length - 16)), decipher.final()]);
};

const aesGcmSeal = (keyBase64: string, plain: Buffer) => {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString("base64");
};

describe("createLibraryKeyStore", () => {
  it("keeps the key under the shared keychain service and calls onChange after each write", async () => {
    const keychain = memoryKeychain();
    const asyncStorage = memoryStorage();
    const onChange = vi.fn(() => expect(keychain.items.has(LIBRARY_KEY_SERVICE)).toBe(true));
    const store = createLibraryKeyStore({ keychain, asyncStorage, onChange });

    expect(await store.get()).toBeNull();
    await store.set("k");
    expect(keychain.items.get(LIBRARY_KEY_SERVICE)).toBe("k");
    expect(await store.get()).toBe("k");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clear removes the key and the acknowledgement", async () => {
    const keychain = memoryKeychain();
    const asyncStorage = memoryStorage();
    const store = createLibraryKeyStore({ keychain, asyncStorage });
    await store.set("k");
    await store.acknowledge();
    expect(asyncStorage.items.get(LIBRARY_KEY_ACK_STORAGE)).toBe("1");
    expect(await store.isAcknowledged()).toBe(true);

    await store.clear();
    expect(await store.get()).toBeNull();
    expect(await store.isAcknowledged()).toBe(false);
  });
});

describe("library key shape", () => {
  it("accepts base64 of 32 bytes, with pasted whitespace", () => {
    const key = nodeCrypto.randomBytes(32).toString("base64");
    expect(isLibraryKeyShape(key)).toBe(true);
    const spaced = `  ${key.slice(0, 20)}\n${key.slice(20)} `;
    expect(isLibraryKeyShape(spaced)).toBe(true);
    expect(normalizeLibraryKey(spaced)).toBe(key);
  });

  it("drops the zero-width characters and line breaks a long-press paste can carry", () => {
    const key = nodeCrypto.randomBytes(32).toString("base64");
    const pasted = `\ufeff${key.slice(0, 4)} ${key.slice(4, 8)}\u200b${key.slice(8, 30)}\r\n${key.slice(30)}\u200d\t`;
    console.log("pasted key with invisible characters, length", pasted.length, "normalized length", normalizeLibraryKey(pasted).length);
    expect(normalizeLibraryKey(pasted)).toBe(key);
    expect(isLibraryKeyShape(pasted)).toBe(true);
  });

  it("rejects other lengths and characters", () => {
    expect(isLibraryKeyShape(nodeCrypto.randomBytes(16).toString("base64"))).toBe(false);
    expect(isLibraryKeyShape(nodeCrypto.randomBytes(33).toString("base64"))).toBe(false);
    expect(isLibraryKeyShape(`${"!".repeat(43)}=`)).toBe(false);
  });
});

describe("checkLibraryKey", () => {
  const key = nodeCrypto.randomBytes(32).toString("base64");
  const probe = aesGcmSeal(key, nodeCrypto.randomBytes(32));

  it("ok when the key opens the probe", async () => {
    expect(await checkLibraryKey(` ${key}\n`, probe, aesGcmOpen)).toBe("ok");
  });

  it("wrong when another key is typed", async () => {
    expect(await checkLibraryKey(nodeCrypto.randomBytes(32).toString("base64"), probe, aesGcmOpen)).toBe("wrong");
  });

  it("malformed before any decrypt, no_probe when the account has none", async () => {
    const decrypt = vi.fn(aesGcmOpen);
    expect(await checkLibraryKey("abc", probe, decrypt)).toBe("malformed");
    expect(await checkLibraryKey(key, null, decrypt)).toBe("no_probe");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("checks a key typed as its 12 words through the key they stand for", async () => {
    const words = generateLibraryKeyWords("fr");
    const wordProbe = aesGcmSeal(words.keyBase64, nodeCrypto.randomBytes(32));
    const typed = words.words.map((word) => word.slice(0, 4).toUpperCase()).join("\n");
    const read = readLibraryKeyInput(typed);
    console.log("typed words", JSON.stringify(typed), "read", read.status);
    expect(read.status).toBe("ok");
    const derived = read.status === "ok" ? read.keyBase64 : "";
    expect(derived).toBe(words.keyBase64);
    expect(await checkLibraryKey(derived, wordProbe, aesGcmOpen)).toBe("ok");
    expect(await checkLibraryKey(derived, probe, aesGcmOpen)).toBe("wrong");
  });
});
