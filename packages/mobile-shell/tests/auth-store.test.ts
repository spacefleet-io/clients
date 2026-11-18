import { describe, expect, it } from "vitest";
import { createAsyncStorageAuthSessionStore } from "../src/services/auth";

const createFakeStorage = () => {
  const backing = new Map<string, string>();
  return {
    getItem: async (key: string) => backing.get(key) ?? null,
    setItem: async (key: string, value: string) => { backing.set(key, value); },
    removeItem: async (key: string) => { backing.delete(key); },
    _backing: backing,
  };
};

// On assertion failure, dump the storage backing + read result so a failure is
// diagnosable offline without re-running ("Tests log generously"). try/catch so
// a dump failure can never mask the real assertion.
const dumpAuthStoreSnapshot = (
  label: string,
  ctx: { backing?: Map<string, string>; session?: unknown; extra?: Record<string, unknown> },
) => {
  try {
    console.error(`=== [auth-store:${label}] snapshot ===`);
    if (ctx.session !== undefined) {
      console.error(`store.read() result:\n${JSON.stringify(ctx.session, null, 2)}`);
    }
    if (ctx.backing !== undefined) {
      console.error(`storage backing keys=${JSON.stringify([...ctx.backing.keys()])}`);
      console.error(`storage backing=${JSON.stringify(Object.fromEntries(ctx.backing), null, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra=${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("async storage auth session store", () => {
  it("writes and reads valid session values", async () => {
    console.info(`[auth-store:write-read] creating store + fake storage`);
    const storage = createFakeStorage();
    const store = createAsyncStorageAuthSessionStore({ asyncStorage: storage });

    console.info(`[auth-store:write-read] writing session token=token-1 user.id=u1`);
    await store.write({
      token: "token-1",
      user: { id: "u1", email: "u1@example.com", emailVerified: true },
    });

    const session = await store.read();
    console.info(`[auth-store:write-read] read-back session=${JSON.stringify(session)}`);
    try {
      expect(session).toMatchObject({
        token: "token-1",
        user: { id: "u1", email: "u1@example.com", emailVerified: true },
      });
    } catch (err) {
      dumpAuthStoreSnapshot("write-read", { backing: storage._backing, session });
      throw err;
    }
  });

  it("clears session on write(null)", async () => {
    console.info(`[auth-store:clear-on-null] creating store + writing then clearing`);
    const storage = createFakeStorage();
    const store = createAsyncStorageAuthSessionStore({ asyncStorage: storage });

    await store.write({
      token: "token-1",
      user: { id: "u1", email: "u1@example.com", emailVerified: true },
    });

    await store.write(null);
    const session = await store.read();
    console.info(`[auth-store:clear-on-null] after write(null) read=${JSON.stringify(session)}`);
    try {
      expect(session).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("clear-on-null", { backing: storage._backing, session });
      throw err;
    }
  });

  it("returns null for malformed JSON payload", async () => {
    console.info(`[auth-store:malformed-json] seeding malformed payload "{not-json"`);
    const storage = createFakeStorage();
    storage._backing.set("spacefleet.mobile.session", "{not-json");

    const store = createAsyncStorageAuthSessionStore({ asyncStorage: storage });
    const session = await store.read();
    console.info(`[auth-store:malformed-json] read result=${JSON.stringify(session)}`);
    try {
      expect(session).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("malformed-json", { backing: storage._backing, session });
      throw err;
    }
  });

  it("returns null when stored session is missing required fields", async () => {
    console.info(`[auth-store:missing-fields] seeding partial payload {token:"t"} (no user)`);
    const storage = createFakeStorage();
    storage._backing.set("spacefleet.mobile.session", JSON.stringify({ token: "t" }));

    const store = createAsyncStorageAuthSessionStore({ asyncStorage: storage });
    const session = await store.read();
    console.info(`[auth-store:missing-fields] read result=${JSON.stringify(session)}`);
    try {
      expect(session).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("missing-fields", { backing: storage._backing, session });
      throw err;
    }
  });

  it("returns null when storage is empty", async () => {
    console.info(`[auth-store:empty-storage] creating store over empty storage`);
    const storage = createFakeStorage();
    const store = createAsyncStorageAuthSessionStore({ asyncStorage: storage });
    const session = await store.read();
    console.info(`[auth-store:empty-storage] read result=${JSON.stringify(session)}`);
    try {
      expect(session).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("empty-storage", { backing: storage._backing, session });
      throw err;
    }
  });

  it("uses custom storage key", async () => {
    console.info(`[auth-store:custom-key] creating store with key=custom.session.key`);
    const storage = createFakeStorage();
    const store = createAsyncStorageAuthSessionStore({
      asyncStorage: storage,
      key: "custom.session.key",
    });

    console.info(`[auth-store:custom-key] writing session token=token-2 user.id=u2`);
    await store.write({
      token: "token-2",
      user: { id: "u2", email: "u2@example.com", emailVerified: false },
    });

    const hasCustom = storage._backing.has("custom.session.key");
    const hasDefault = storage._backing.has("spacefleet.mobile.session");
    console.info(
      `[auth-store:custom-key] hasCustomKey=${hasCustom} hasDefaultKey=${hasDefault} keys=${JSON.stringify([...storage._backing.keys()])}`,
    );
    try {
      expect(hasCustom).toBe(true);
      expect(hasDefault).toBe(false);
    } catch (err) {
      dumpAuthStoreSnapshot("custom-key", { backing: storage._backing, extra: { hasCustom, hasDefault } });
      throw err;
    }
  });
});
