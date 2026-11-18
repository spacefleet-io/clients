import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, login, setApiBaseUrl } from "../src/api";
import {
  classifySignInError,
  isRateLimited,
  RATE_LIMIT_DEFAULT_MINUTES,
  REQUEST_TIMEOUT_ERROR,
  retryAfterMinutes,
  signInErrorDetails,
  signInErrorMessage,
  signInErrorMessageKey,
  signInErrorText,
  signInErrorTexts,
  signInErrorValues,
  tooManyAttemptsText,
  withSignInErrorTexts,
  type SignInFailure,
} from "../src/signInError";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const describeErr = (err: unknown) =>
  err instanceof ApiError ? { name: err.name, status: err.status, payload: err.payload } : err instanceof Error ? { name: err.name, message: err.message } : err;

describe("sign-in errors say the real cause (ACCT-AUTH-11)", () => {
  const cases: Array<[string, unknown, SignInFailure, string]> = [
    ["wrong password (401)", new ApiError(401, { error: "invalid_credentials" }), "credentials", "login.errors.credentials"],
    ["wrong password (400)", new ApiError(400, { error: "invalid_credentials" }), "credentials", "login.errors.credentials"],
    ["second step needed", new ApiError(401, { error: "two_factor_required", method: "totp" }), "twoFactorRequired", "login.errors.unknown"],
    ["wrong second-step code", new ApiError(401, { error: "two_factor_invalid" }), "twoFactorInvalid", "login.errors.invalidCode"],
    ["email not confirmed", new ApiError(403, { error: "email_not_verified" }), "emailNotVerified", "login.errors.emailNotVerified"],
    ["deletion pending", new ApiError(409, { error: "account_deletion_pending" }), "deletionPending", "login.errors.deletionPending"],
    ["timed out", new ApiError(0, { error: REQUEST_TIMEOUT_ERROR }), "timeout", "login.errors.timeout"],
    ["no response", new ApiError(0, { error: "no_response" }), "unreachable", "login.errors.unreachable"],
    ["2xx that is not JSON", new ApiError(200, { error: "invalid_response" }), "notApi", "login.errors.unreachable"],
    ["HTML 404 (website page, proxy)", new ApiError(404, { error: "Not Found" }), "notApi", "login.errors.unreachable"],
    ["captive portal 403 without an API code", new ApiError(403, {}), "notApi", "login.errors.unreachable"],
    ["API crashed", new ApiError(500, { error: "login_failed" }), "serverError", "login.errors.serverError"],
    ["bad gateway", new ApiError(502, {}), "serverError", "login.errors.serverError"],
    ["rate limited", new ApiError(429, { error: "rate_limited", retryAfterSeconds: 840 }), "rateLimited", "login.errors.tooManyAttempts"],
    ["429 from a proxy, no API code", new ApiError(429, {}), "rateLimited", "login.errors.tooManyAttempts"],
    ["React Native offline", new TypeError("Network request failed"), "unreachable", "login.errors.unreachable"],
    ["browser offline", new TypeError("Failed to fetch"), "unreachable", "login.errors.unreachable"],
    ["DNS failure (undici)", Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.spacefleet.io") }), "unreachable", "login.errors.unreachable"],
    ["TLS failure", new Error("SSL handshake aborted: certificate verify failed"), "unreachable", "login.errors.unreachable"],
    ["aborted fetch", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), "timeout", "login.errors.timeout"],
    ["HTML body parsed as JSON", new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), "notApi", "login.errors.unreachable"],
    ["something odd", new Error("boom"), "unknown", "login.errors.unknown"],
    ["not even an error", "boom", "unknown", "login.errors.unknown"],
  ];

  // @req ACCT-AUTH-11
  it.each(cases)("%s", (label, err, failure, key) => {
    const got = classifySignInError(err);
    const gotKey = signInErrorMessageKey(got);
    console.info("[sign-in-error]", JSON.stringify({ label, err: describeErr(err), got, gotKey, details: signInErrorDetails(err) }));
    expect(got).toBe(failure);
    expect(gotKey).toBe(key);
  });

  // @req ACCT-AUTH-11
  it("only a wrong email or password blames the credentials", () => {
    const blaming = cases.filter(([, , failure]) => signInErrorMessageKey(failure) === "login.errors.credentials").map(([label]) => label);
    console.info("[sign-in-error] blames credentials:", blaming);
    expect(blaming).toEqual(["wrong password (401)", "wrong password (400)"]);
  });

  // @req ACCT-AUTH-11
  it("logs no credentials", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
    const details = signInErrorDetails(err);
    console.info("[sign-in-error] details:", details);
    expect(JSON.stringify(details)).not.toMatch(/password|hunter2/);
    expect(signInErrorDetails(new ApiError(401, { error: "invalid_credentials" }))).toEqual({ status: 401, error: "invalid_credentials" });
  });

  // @req ACCT-AUTH-11
  it.each([
    ["14 min exactly", 840, 14],
    ["one second over a minute rounds up", 61, 2],
    ["under a minute is still 1", 5, 1],
    ["0 seconds is still 1", 0, 1],
    ["the 15-minute login window", 900, 15],
    ["the 1-hour email window", 3600, 60],
  ])("too many attempts: %s", (label, seconds, minutes) => {
    const err = new ApiError(429, { error: "rate_limited", retryAfterSeconds: seconds });
    const got = { minutes: retryAfterMinutes(err), values: signInErrorValues(err), rateLimited: isRateLimited(err) };
    console.info("[sign-in-error:retry-after]", JSON.stringify({ label, seconds, got }));
    expect(got).toEqual({ minutes, values: { count: minutes, minutes }, rateLimited: true });
  });

  // @req ACCT-AUTH-11
  it("a 429 that does not say when falls back to the default wait; other errors are not rate limits", () => {
    const proxy = new ApiError(429, {});
    const odd = new ApiError(429, { error: "rate_limited", retryAfterSeconds: "soon" });
    const got = {
      proxy: retryAfterMinutes(proxy),
      odd: retryAfterMinutes(odd),
      proxyLimited: isRateLimited(proxy),
      serverLimited: isRateLimited(new ApiError(500, { error: "login_failed" })),
      networkLimited: isRateLimited(new TypeError("Failed to fetch")),
    };
    console.info("[sign-in-error:retry-after-default]", JSON.stringify(got));
    expect(got).toEqual({
      proxy: RATE_LIMIT_DEFAULT_MINUTES,
      odd: RATE_LIMIT_DEFAULT_MINUTES,
      proxyLimited: true,
      serverLimited: false,
      networkLimited: false,
    });
  });

  // @req ACCT-AUTH-11
  it("tooManyAttemptsText asks for the shared sentence only on a 429", () => {
    const calls: Array<[string, unknown]> = [];
    const t = (key: string, values: { count: number; minutes: number }) => {
      calls.push([key, values]);
      return `${key}:${values.minutes}`;
    };
    const limited = tooManyAttemptsText(t, new ApiError(429, { error: "rate_limited", retryAfterSeconds: 120 }));
    const other = tooManyAttemptsText(t, new ApiError(401, { error: "invalid_credentials" }));
    console.info("[sign-in-error:too-many-text]", JSON.stringify({ limited, other, calls }));
    expect(limited).toBe("login.errors.tooManyAttempts:2");
    expect(other).toBeNull();
    expect(calls).toEqual([["login.errors.tooManyAttempts", { count: 2, minutes: 2 }]]);
  });
});

describe("login() gives up when the server never answers (ACCT-AUTH-11)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setApiBaseUrl("https://api.test");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // @req ACCT-AUTH-11
  it("rejects with the timeout error and aborts the request", async () => {
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((input: Request) => {
      seenSignal = input.signal;
      // A server that accepts the connection and never answers; honours the abort like a real fetch.
      const { promise, reject } = Promise.withResolvers<Response>();
      input.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      return promise;
    });
    const startedAt = Date.now();
    const err = await login("alex@example.com", "hunter2", undefined, undefined, undefined, 50).catch((e: unknown) => e);
    console.info("[sign-in-timeout] aborts:", JSON.stringify({ ms: Date.now() - startedAt, err: describeErr(err), aborted: seenSignal?.aborted }));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).payload.error).toBe(REQUEST_TIMEOUT_ERROR);
    expect(classifySignInError(err)).toBe("timeout");
    expect(seenSignal?.aborted).toBe(true);
  });

  // @req ACCT-AUTH-11
  it("still ends when the fetch ignores the abort", async () => {
    fetchMock.mockImplementation(() => Promise.withResolvers<Response>().promise);
    const startedAt = Date.now();
    const err = await login("alex@example.com", "hunter2", undefined, undefined, undefined, 50).catch((e: unknown) => e);
    console.info("[sign-in-timeout] ignores abort:", JSON.stringify({ ms: Date.now() - startedAt, err: describeErr(err) }));
    expect(classifySignInError(err)).toBe("timeout");
  });

  // @req ACCT-AUTH-11
  it("an HTML page instead of the API reads as unreachable, not as a wrong password", async () => {
    fetchMock.mockResolvedValue(
      new Response("<!DOCTYPE html><html><body>Page not found</body></html>", { status: 404, headers: { "content-type": "text/html" } })
    );
    const err = await login("alex@example.com", "hunter2").catch((e: unknown) => e);
    const failure = classifySignInError(err);
    console.info("[sign-in-html]", JSON.stringify({ err: describeErr(err), failure, key: signInErrorMessageKey(failure) }));
    expect(signInErrorMessageKey(failure)).toBe("login.errors.unreachable");
  });

  // @req ACCT-AUTH-11
  it("a fast answer is not cut short", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: "t", user: { id: "u", email: "alex@example.com" } }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const out = await login("alex@example.com", "hunter2", undefined, undefined, undefined, 5_000);
    console.info("[sign-in-ok]", JSON.stringify({ token: out.token, user: out.user }));
    expect(out.token).toBe("t");
  });
});

// @req ACCT-AUTH-11
describe("shared sign-in error texts", () => {
  const failures: SignInFailure[] = [
    "credentials",
    "twoFactorRequired",
    "twoFactorInvalid",
    "emailNotVerified",
    "deletionPending",
    "timeout",
    "unreachable",
    "notApi",
    "serverError",
    "rateLimited",
    "unknown",
  ];
  it.each(Object.keys(signInErrorTexts) as (keyof typeof signInErrorTexts)[])(
    "%s has a sentence for every failure, reached through the login.errors key",
    (language) => {
      const tree = withSignInErrorTexts({ login: { title: "kept" } }, language) as {
        login: { title: string; errors: Record<string, string> };
      };
      const resolved = failures.map((failure) => [failure, tree.login.errors[signInErrorMessageKey(failure).slice("login.errors.".length)]]);
      console.info(`[sign-in-texts] ${language}`, JSON.stringify(resolved));
      expect(resolved.filter(([, text]) => !text?.trim())).toEqual([]);
      expect(tree.login.title).toBe("kept");
    },
  );

  it.each([
    ["en", 14, "Too many attempts. Try again in 14 minutes."],
    ["en", 1, "Too many attempts. Try again in 1 minute."],
    ["fr", 14, "Trop de tentatives. Réessayez dans 14 minutes."],
    ["fr", 1, "Trop de tentatives. Réessayez dans 1 minute."],
    ["nl", 14, "Te veel pogingen. Probeer het over 14 minuten opnieuw."],
    ["nl", 1, "Te veel pogingen. Probeer het over 1 minuut opnieuw."],
    ["de", 14, "Zu viele Versuche. Versuch es in 14 Minuten nochmal."],
    ["de", 1, "Zu viele Versuche. Versuch es in 1 Minute nochmal."],
    ["es", 14, "Demasiados intentos. Vuelve a intentarlo en 14 minutos."],
    ["es", 1, "Demasiados intentos. Vuelve a intentarlo en 1 minuto."],
  ] as const)("%s, %i minutes: the too-many-attempts sentence with its own plural", (language, minutes, expected) => {
    const text = signInErrorText(language, signInErrorMessage("rateLimited"), minutes);
    console.info(`[sign-in-texts:too-many] ${language} ${minutes}`, text);
    expect(text).toBe(expected);
  });

  it("signInErrorText leaves the other sentences as written", () => {
    const text = signInErrorText("en", "credentials", 3);
    console.info("[sign-in-texts:other]", text);
    expect(text).toBe(signInErrorTexts.en.credentials);
  });
});
