import { describe, it, expect, vi } from "vitest";
import { createRuntimeSession } from "../src/session";

const SUITE = "runtime-client-session";
const BASE_URL = "http://127.0.0.1:3020";

const fakeLoginResponse = (token = "rt-token-1") =>
  new Response(
    JSON.stringify({
      ok: true,
      token,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      capabilities: { apps: ["badger"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const summarizeLoginCalls = (fetchMock: ReturnType<typeof vi.fn>) => {
  try {
    return fetchMock.mock.calls.map((call, idx) => {
      const [url, init] = call as [unknown, unknown];
      const initRecord = (init && typeof init === "object" ? init : {}) as {
        method?: unknown;
        headers?: unknown;
        body?: unknown;
      };
      let parsedBody: unknown = initRecord.body ?? null;
      if (typeof parsedBody === "string" && parsedBody.length > 0) {
        try {
          parsedBody = JSON.parse(parsedBody);
        } catch {
          // leave as string
        }
      }
      const headers =
        initRecord.headers && typeof initRecord.headers === "object"
          ? (initRecord.headers as Record<string, unknown>)
          : null;
      return {
        idx,
        url,
        method: initRecord.method ?? "GET",
        backendToken:
          parsedBody && typeof parsedBody === "object"
            ? (parsedBody as Record<string, unknown>).backendToken
            : null,
        apps:
          parsedBody && typeof parsedBody === "object"
            ? (parsedBody as Record<string, unknown>).apps
            : null,
        headerKeys: headers ? Object.keys(headers) : null,
      };
    });
  } catch (err) {
    return `(login-trace failed: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const dumpSessionSnapshot = (
  label: string,
  ctx: {
    fetchMock: ReturnType<typeof vi.fn>;
    onTokenChange?: ReturnType<typeof vi.fn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`login fetch count: ${ctx.fetchMock.mock.calls.length}`);
    console.error(
      `recent login calls:\n${JSON.stringify(summarizeLoginCalls(ctx.fetchMock), null, 2)}`,
    );
    if (ctx.onTokenChange) {
      console.error(
        `onTokenChange invocations (${ctx.onTokenChange.mock.calls.length}):\n${JSON.stringify(
          ctx.onTokenChange.mock.calls.map((c) => c[0]),
          null,
          2,
        )}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra state:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("createRuntimeSession", () => {
  console.info(
    `[${SUITE}:setup] BASE_URL=${BASE_URL} suite=session-handle (login/cache/invalidate/dedupe/reset)`,
  );

  it("logs in and returns a token on first getToken()", async () => {
    console.info(`[${SUITE}:first-getToken] creating session and requesting token`);
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse());
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      apps: ["badger"],
      fetchImpl: fetchMock,
    });

    let token: string | null = null;
    try {
      token = await session.getToken();
      expect(token).toBe("rt-token-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${BASE_URL}/runtime/session/login`,
      );
      console.info(`[${SUITE}:first-getToken] token=${token} calls=1 OK`);
    } catch (err) {
      dumpSessionSnapshot("first-getToken-mismatch", {
        fetchMock,
        extra: { observedToken: token },
      });
      throw err;
    }
  });

  it("caches token across getToken() calls", async () => {
    console.info(`[${SUITE}:cache] expect 2 getToken() → 1 fetch`);
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse());
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    let t1: string | null = null;
    let t2: string | null = null;
    try {
      t1 = await session.getToken();
      t2 = await session.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      console.info(`[${SUITE}:cache] OK tokens=[${t1}, ${t2}] calls=1`);
    } catch (err) {
      dumpSessionSnapshot("cache-not-honored", {
        fetchMock,
        extra: { t1, t2 },
      });
      throw err;
    }
  });

  it("re-logins after invalidate()", async () => {
    console.info(`[${SUITE}:invalidate] expect invalidate → re-login`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse("token-1"))
      .mockResolvedValueOnce(fakeLoginResponse("token-2"));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    let before: string | null = null;
    let after: string | null = null;
    try {
      before = await session.getToken();
      expect(before).toBe("token-1");
      console.info(`[${SUITE}:invalidate] pre-invalidate token=${before}`);
      session.invalidate();
      after = await session.getToken();
      expect(after).toBe("token-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      console.info(`[${SUITE}:invalidate] post-invalidate token=${after} calls=2`);
    } catch (err) {
      dumpSessionSnapshot("invalidate-did-not-relogin", {
        fetchMock,
        extra: { before, after },
      });
      throw err;
    }
  });

  it("re-logins when backendToken changes via setBackendToken()", async () => {
    console.info(`[${SUITE}:setBackendToken] expect token swap → re-login`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse("token-a"))
      .mockResolvedValueOnce(fakeLoginResponse("token-b"));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-1",
      fetchImpl: fetchMock,
    });

    let a: string | null = null;
    let b: string | null = null;
    try {
      a = await session.getToken();
      expect(a).toBe("token-a");
      console.info(`[${SUITE}:setBackendToken] token-a=${a}, swapping backendToken`);
      session.setBackendToken("backend-2");
      b = await session.getToken();
      expect(b).toBe("token-b");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      console.info(`[${SUITE}:setBackendToken] token-b=${b} calls=2`);
    } catch (err) {
      dumpSessionSnapshot("setBackendToken-did-not-relogin", {
        fetchMock,
        extra: { tokenAfterFirst: a, tokenAfterSwap: b },
      });
      throw err;
    }
  });

  it("deduplicates concurrent login requests", async () => {
    console.info(`[${SUITE}:dedupe] expect 3 concurrent getToken() → 1 fetch`);
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse());
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    let t1: string | null = null;
    let t2: string | null = null;
    let t3: string | null = null;
    try {
      [t1, t2, t3] = await Promise.all([
        session.getToken(),
        session.getToken(),
        session.getToken(),
      ]);
      expect(t1).toBe("rt-token-1");
      expect(t2).toBe("rt-token-1");
      expect(t3).toBe("rt-token-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      console.info(
        `[${SUITE}:dedupe] OK tokens=[${t1}, ${t2}, ${t3}] calls=1`,
      );
    } catch (err) {
      dumpSessionSnapshot("dedupe-leaked-extra-login-calls", {
        fetchMock,
        extra: { t1, t2, t3 },
      });
      throw err;
    }
  });

  it("calls onTokenChange on login and invalidation", async () => {
    console.info(`[${SUITE}:onTokenChange] expecting login → "tok", invalidate → null`);
    const onTokenChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse("tok"));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
      onTokenChange,
    });

    try {
      await session.getToken();
      expect(onTokenChange).toHaveBeenCalledWith("tok");
      console.info(`[${SUITE}:onTokenChange] login callback invoked OK`);

      session.invalidate();
      expect(onTokenChange).toHaveBeenCalledWith(null);
      console.info(`[${SUITE}:onTokenChange] invalidate callback invoked OK`);
    } catch (err) {
      dumpSessionSnapshot("onTokenChange-callback-drift", {
        fetchMock,
        onTokenChange,
      });
      throw err;
    }
  });

  it("throws on non-200 login response", async () => {
    console.info(`[${SUITE}:non-200] simulating HTTP 500 from login endpoint`);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 500 }));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    try {
      await expect(session.getToken()).rejects.toThrow("runtime_login_http_500");
      console.info(`[${SUITE}:non-200] OK got runtime_login_http_500`);
    } catch (err) {
      dumpSessionSnapshot("non-200-did-not-throw-expected-error", {
        fetchMock,
      });
      throw err;
    }
  });

  it("throws on invalid login response body", async () => {
    console.info(`[${SUITE}:invalid-body] simulating malformed JSON body`);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ weird: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    try {
      await expect(session.getToken()).rejects.toThrow(
        "runtime_login_invalid_response",
      );
      console.info(`[${SUITE}:invalid-body] OK got runtime_login_invalid_response`);
    } catch (err) {
      dumpSessionSnapshot("invalid-body-did-not-throw-expected-error", {
        fetchMock,
      });
      throw err;
    }
  });

  it("normalizes trailing slashes on runtimeBaseUrl", async () => {
    console.info(`[${SUITE}:normalize-url] base passed with trailing slashes`);
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse());
    const session = createRuntimeSession({
      runtimeBaseUrl: "http://127.0.0.1:3020///",
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
    });

    try {
      await session.getToken();
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://127.0.0.1:3020/runtime/session/login",
      );
      console.info(`[${SUITE}:normalize-url] OK normalized URL`);
    } catch (err) {
      dumpSessionSnapshot("normalize-url-did-not-strip-slashes", {
        fetchMock,
        extra: { actualUrl: fetchMock.mock.calls[0]?.[0] },
      });
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // @bugfix the-app-restart-fixed-soft-pixel — expiry-aware cache.
  //
  // Pre-fix: getToken() returned cachedToken indefinitely as long as
  // backendToken hadn't changed. The runtime's session TTL (default 60 min)
  // would tick past, the server-side sessions Map dropped the row, and the
  // client kept handing out the stale token — visible to the user as the
  // SSE-only 401 (because /v2/list was unauth'd, see commit 754993df) that
  // produced the "Ingest unavailable — runtime engine v2 not ready" banner.
  //
  // Post-fix: the session client parses `expiresAt` from the login response,
  // and treats the cache as fresh only while
  //   clock() < cachedExpiresAtMs - EXPIRY_REFRESH_MARGIN_MS (30s).
  // Tests drive `clock` via the injected seam so we don't fight global
  // vi.useFakeTimers() across the file.
  // @regression-proof
  // -------------------------------------------------------------------------
  describe("expiry-aware cache @bugfix @regression-proof", () => {
    const SUITE_EXPIRY = `${SUITE}:expiry`;

    const fakeLoginResponseAt = (token: string, expiresAtIso: string) =>
      new Response(
        JSON.stringify({
          ok: true,
          token,
          expiresAt: expiresAtIso,
          capabilities: { apps: ["badger"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    it("returns cached token when still well within TTL (>30s margin)", async () => {
      console.info(`[${SUITE_EXPIRY}:within-ttl] expect 2 getToken() with t=0 + t=30min → 1 login`);
      // Fixed virtual clock starting at t=0; expiresAt is 1 hour later.
      let now = 0;
      const expiresAtMs = 60 * 60 * 1000;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeLoginResponseAt("token-fresh", new Date(expiresAtMs).toISOString()),
        );
      const session = createRuntimeSession({
        runtimeBaseUrl: BASE_URL,
        backendToken: "backend-abc",
        fetchImpl: fetchMock,
        clock: () => now,
      });

      let t1: string | null = null;
      let t2: string | null = null;
      try {
        t1 = await session.getToken();
        // Advance the clock 30 min — well within the 1-hour TTL.
        now = 30 * 60 * 1000;
        t2 = await session.getToken();
        expect(t1).toBe("token-fresh");
        expect(t2).toBe("token-fresh");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        console.info(`[${SUITE_EXPIRY}:within-ttl] OK calls=1`);
      } catch (err) {
        dumpSessionSnapshot("within-ttl-cache-miss", { fetchMock, extra: { t1, t2, now } });
        throw err;
      }
    });

    it("re-logins automatically when the cached token is within the 30s refresh margin", async () => {
      console.info(`[${SUITE_EXPIRY}:margin-refresh] expect 2 getToken() across the margin → 2 logins`);
      let now = 0;
      const expiresAtMs = 60 * 1000; // 60s TTL for compact test math
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeLoginResponseAt("token-1", new Date(expiresAtMs).toISOString()),
        )
        .mockResolvedValueOnce(
          fakeLoginResponseAt(
            "token-2",
            new Date(expiresAtMs + 60 * 1000).toISOString(),
          ),
        );
      const session = createRuntimeSession({
        runtimeBaseUrl: BASE_URL,
        backendToken: "backend-abc",
        fetchImpl: fetchMock,
        clock: () => now,
      });

      let t1: string | null = null;
      let t2: string | null = null;
      try {
        t1 = await session.getToken();
        expect(t1).toBe("token-1");
        // Advance clock to 35s — within the 30s pre-expiry refresh window
        // (expiresAt=60s, margin=30s, refresh boundary=30s).
        now = 35 * 1000;
        t2 = await session.getToken();
        expect(t2).toBe("token-2");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        console.info(
          `[${SUITE_EXPIRY}:margin-refresh] OK t1=${t1} t2=${t2} calls=2`,
        );
      } catch (err) {
        dumpSessionSnapshot("margin-refresh-did-not-fire", {
          fetchMock,
          extra: { t1, t2, now, expiresAtMs },
        });
        throw err;
      }
    });

    it("re-logins after the cached token has fully expired", async () => {
      console.info(`[${SUITE_EXPIRY}:expired] expect getToken() after expiry → fresh login`);
      let now = 0;
      const expiresAtMs = 60 * 1000;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeLoginResponseAt("token-old", new Date(expiresAtMs).toISOString()),
        )
        .mockResolvedValueOnce(
          fakeLoginResponseAt(
            "token-new",
            new Date(expiresAtMs * 2).toISOString(),
          ),
        );
      const session = createRuntimeSession({
        runtimeBaseUrl: BASE_URL,
        backendToken: "backend-abc",
        fetchImpl: fetchMock,
        clock: () => now,
      });

      let before: string | null = null;
      let after: string | null = null;
      try {
        before = await session.getToken();
        // Jump well past the absolute expiry boundary.
        now = expiresAtMs + 5 * 60 * 1000;
        after = await session.getToken();
        expect(before).toBe("token-old");
        expect(after).toBe("token-new");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        console.info(`[${SUITE_EXPIRY}:expired] OK before=${before} after=${after} calls=2`);
      } catch (err) {
        dumpSessionSnapshot("expired-did-not-refresh", {
          fetchMock,
          extra: { before, after, now, expiresAtMs },
        });
        throw err;
      }
    });

    it("multiple concurrent getToken() across the refresh boundary still produce ONE login (dedupe holds under expiry)", async () => {
      console.info(`[${SUITE_EXPIRY}:dedupe-across-expiry] expect 3 concurrent getToken() at expired clock → 1 login`);
      let now = 0;
      const expiresAtMs = 60 * 1000;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeLoginResponseAt("token-seed", new Date(expiresAtMs).toISOString()),
        )
        .mockResolvedValueOnce(
          fakeLoginResponseAt(
            "token-refreshed",
            new Date(expiresAtMs * 3).toISOString(),
          ),
        );
      const session = createRuntimeSession({
        runtimeBaseUrl: BASE_URL,
        backendToken: "backend-abc",
        fetchImpl: fetchMock,
        clock: () => now,
      });

      try {
        const seed = await session.getToken();
        expect(seed).toBe("token-seed");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Cross the expiry boundary, then fire 3 concurrent requests.
        now = expiresAtMs + 10 * 1000;
        const [a, b, c] = await Promise.all([
          session.getToken(),
          session.getToken(),
          session.getToken(),
        ]);
        expect(a).toBe("token-refreshed");
        expect(b).toBe("token-refreshed");
        expect(c).toBe("token-refreshed");
        // Only ONE additional login fetch for the burst (total = 2 across the test).
        expect(fetchMock).toHaveBeenCalledTimes(2);
        console.info(`[${SUITE_EXPIRY}:dedupe-across-expiry] OK calls=2`);
      } catch (err) {
        dumpSessionSnapshot("dedupe-across-expiry-leaked-extra-logins", {
          fetchMock,
          extra: { now, expiresAtMs },
        });
        throw err;
      }
    });

    it("invalidate() clears the cached expiry too — next getToken() re-logs even if absolute time is well within the original TTL", async () => {
      console.info(`[${SUITE_EXPIRY}:invalidate-clears-expiry] expect invalidate inside TTL → re-login on next getToken`);
      let now = 0;
      const expiresAtMs = 60 * 60 * 1000;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fakeLoginResponseAt("token-first", new Date(expiresAtMs).toISOString()),
        )
        .mockResolvedValueOnce(
          fakeLoginResponseAt(
            "token-second",
            new Date(expiresAtMs * 2).toISOString(),
          ),
        );
      const session = createRuntimeSession({
        runtimeBaseUrl: BASE_URL,
        backendToken: "backend-abc",
        fetchImpl: fetchMock,
        clock: () => now,
      });

      let pre: string | null = null;
      let post: string | null = null;
      try {
        pre = await session.getToken();
        expect(pre).toBe("token-first");
        // Sanity: still within TTL — without invalidate, this would be a cache hit.
        now = 5 * 60 * 1000;
        session.invalidate();
        post = await session.getToken();
        expect(post).toBe("token-second");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        console.info(`[${SUITE_EXPIRY}:invalidate-clears-expiry] OK pre=${pre} post=${post}`);
      } catch (err) {
        dumpSessionSnapshot("invalidate-did-not-clear-expiry", {
          fetchMock,
          extra: { pre, post, now },
        });
        throw err;
      }
    });
  });

  it("reset() clears everything including in-flight state", async () => {
    console.info(`[${SUITE}:reset] expect reset → re-login + null token callback`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse("t1"))
      .mockResolvedValueOnce(fakeLoginResponse("t2"));
    const onTokenChange = vi.fn();
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      fetchImpl: fetchMock,
      onTokenChange,
    });

    let t1: string | null = null;
    let t2: string | null = null;
    try {
      t1 = await session.getToken();
      console.info(`[${SUITE}:reset] pre-reset token=${t1}`);
      session.reset();
      expect(onTokenChange).toHaveBeenLastCalledWith(null);
      t2 = await session.getToken();
      expect(t2).toBe("t2");
      console.info(`[${SUITE}:reset] post-reset token=${t2}`);
    } catch (err) {
      dumpSessionSnapshot("reset-did-not-clear-state", {
        fetchMock,
        onTokenChange,
        extra: { t1, t2 },
      });
      throw err;
    }
  });
});

describe("createRuntimeSession owner secret (RT-SEC-05)", () => {
  const refusal = (error = "owner_secret_invalid") =>
    new Response(JSON.stringify({ error }), { status: 401, headers: { "content-type": "application/json" } });
  const sentSecret = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    ((fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers)["x-runtime-owner"];

  it("sends the provider's secret as X-Runtime-Owner on login @req RT-SEC-05[badger-desktop]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse("owned"));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "bt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ownerSecret: async () => "a".repeat(64),
    });
    expect(await session.getToken()).toBe("owned");
    expect(sentSecret(fetchMock, 0)).toBe("a".repeat(64));
    console.info(`[${SUITE}:owner-secret] header sent`);
  });

  it("re-reads the secret when the runtime refuses it, so a restarted runtime works @req RT-SEC-05[badger-desktop]", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(fakeLoginResponse("after-restart"));
    const provider = vi.fn().mockResolvedValueOnce("old-secret").mockResolvedValueOnce("new-secret");
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "bt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ownerSecret: provider,
    });
    expect(await session.getToken()).toBe("after-restart");
    expect(sentSecret(fetchMock, 0)).toBe("old-secret");
    expect(sentSecret(fetchMock, 1)).toBe("new-secret");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not retry with the same refused secret @req RT-SEC-05[badger-desktop]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(refusal());
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "bt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ownerSecret: () => "same",
    });
    await expect(session.getToken()).rejects.toThrow("runtime_login_http_401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs in without the header when no secret is readable, and surfaces the runtime's refusal @req RT-SEC-05[badger-desktop]", async () => {
    const fetchMock = vi.fn().mockResolvedValue(refusal("owner_secret_required"));
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "bt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ownerSecret: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(session.getToken()).rejects.toThrow("runtime_login_http_401");
    expect(sentSecret(fetchMock, 0)).toBeUndefined();
  });

  it("calls the provider again on every login instead of caching the secret @req RT-SEC-05[badger-desktop]", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => fakeLoginResponse());
    const provider = vi.fn().mockReturnValueOnce("one").mockReturnValueOnce("two");
    const session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "bt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ownerSecret: provider,
    });
    await session.getToken();
    session.invalidate();
    await session.getToken();
    expect(sentSecret(fetchMock, 0)).toBe("one");
    expect(sentSecret(fetchMock, 1)).toBe("two");
  });
});
