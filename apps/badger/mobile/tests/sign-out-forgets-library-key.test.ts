/**
 * @test-id MOBILE-AUTH-SIGN-OUT-KEY-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: Android QA (2026-11-08) signed the phone out from Settings, signed back in to the same account
 * and landed straight on Home: the library key was still on the phone. The user's own Sign out must forget the key
 * (as on Parrot, #1361, `keyAfterSignedOut`); a session the server refused keeps it so signing in again opens the
 * library.
 *
 * Mounts the real AuthProvider with react-test-renderer; the key store is a spy.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextValue } from "../src/store/auth";

const ctl = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  events: [] as string[],
  rejectMe: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => ctl.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      ctl.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      ctl.storage.delete(key);
    },
  },
}));
vi.mock("../src/lib/libraryDb", () => ({ LibraryDb: { clearLocalCache: async () => undefined } }));
vi.mock("../src/lib/assets", () => ({ clearAssetUrlCache: () => undefined }));
vi.mock("../src/lib/pairing/deviceWatch", () => ({ forgetKnownSessions: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({
  clearLibraryKey: async () => void ctl.events.push("clearLibraryKey"),
  keptKeyOwnerStore: {
    read: async () => ctl.storage.get("sf_library_key_owner") ?? null,
    write: async (userId: string) => void ctl.storage.set("sf_library_key_owner", userId),
    forget: async () => void ctl.storage.delete("sf_library_key_owner"),
  },
}));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getMe: async () => {
      if (ctl.rejectMe) throw new actual.ApiError(401, { error: "unauthorized" });
      return { user: { id: "u1", email: "a@example.com", displayName: "A" } };
    },
    login: async (email: string) => {
      const id = email === "a@example.com" ? "u1" : "u2";
      return { token: `token-${id}`, user: { id, email, displayName: id } };
    },
    logout: async () => void ctl.events.push("apiLogout"),
  };
});

const { AuthProvider, useAuth } = await import("../src/store/auth");

let renderer: ReactTestRenderer | null = null;
let auth: AuthContextValue | null = null;

const Probe = () => {
  auth = useAuth();
  return null;
};

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storage.clear();
  ctl.events.length = 0;
  ctl.rejectMe = false;
  ctl.storage.set("sf_auth_token", "saved-token");
  ctl.storage.set("sf_auth_user", JSON.stringify({ id: "u1", email: "a@example.com", displayName: "A" }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await act(async () => {
    renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  auth = null;
});

describe("library key on the phone after a sign-out", () => {
  it("@bugfix @regression-proof the user's own Sign out forgets the library key", async () => {
    await act(async () => {
      await auth?.logout("signOut");
    });
    console.info("[sign-out-key] signOut events", ctl.events, "token", auth?.token);
    expect(auth?.token).toBeNull();
    expect(ctl.events).toEqual(["apiLogout", "clearLibraryKey"]);
  });

  it("a session the server refused keeps the key so signing in again opens the library", async () => {
    await act(async () => {
      await auth?.logout("sessionRejected");
    });
    console.info("[sign-out-key] sessionRejected events", ctl.events, "token", auth?.token);
    expect(auth?.token).toBeNull();
    expect(ctl.events).not.toContain("clearLibraryKey");
  });
});

describe("@req PRIV-KEY-03 @req REL-FAM-03 a key kept from a refused session goes back only to its account", () => {
  it("@bugfix @regression-proof another account signing in after a refused session does not get the kept key", async () => {
    await act(async () => {
      await auth?.logout("sessionRejected");
    });
    console.info("[sign-out-key] owner after refusal", ctl.storage.get("sf_library_key_owner"));
    expect(ctl.events).not.toContain("clearLibraryKey");
    await act(async () => {
      await auth?.login("b@example.com", "pw");
    });
    console.info("[sign-out-key] other account signed in", ctl.events, "owner", ctl.storage.get("sf_library_key_owner"));
    expect(auth?.user?.id).toBe("u2");
    expect(ctl.events).toContain("clearLibraryKey");
    expect(ctl.storage.has("sf_library_key_owner")).toBe(false);
  });

  it("the same account signing in again after a refused session keeps its key", async () => {
    await act(async () => {
      await auth?.logout("sessionRejected");
    });
    await act(async () => {
      await auth?.login("a@example.com", "pw");
    });
    console.info("[sign-out-key] same account signed in", ctl.events, "owner", ctl.storage.get("sf_library_key_owner"));
    expect(auth?.user?.id).toBe("u1");
    expect(ctl.events).not.toContain("clearLibraryKey");
    expect(ctl.storage.has("sf_library_key_owner")).toBe(false);
  });

  it("@bugfix @regression-proof a saved session refused at start keeps the key for its own account only", async () => {
    await act(async () => {
      renderer?.unmount();
    });
    ctl.rejectMe = true;
    await act(async () => {
      renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)));
    });
    await flush();
    console.info("[sign-out-key] refused at start", { token: auth?.token, owner: ctl.storage.get("sf_library_key_owner") });
    expect(auth?.token).toBeNull();
    expect(ctl.storage.get("sf_library_key_owner")).toBe("u1");
    await act(async () => {
      await auth?.login("b@example.com", "pw");
    });
    expect(ctl.events).toContain("clearLibraryKey");
  });

  it("a paired session (setSession) for another account drops the kept key too", async () => {
    await act(async () => {
      await auth?.logout("sessionRejected");
    });
    await act(async () => {
      await auth?.setSession("token-u2", { id: "u2", email: "b@example.com", displayName: "B" } as never);
    });
    console.info("[sign-out-key] paired other account", ctl.events);
    expect(ctl.events).toContain("clearLibraryKey");
  });
});
