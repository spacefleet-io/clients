import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "@space/shared/api";

/**
 * Badger on a computer signs in as `badger-desktop`, as Parrot does as `parrot-desktop`: the API lets only a
 * `<app>-<deviceType>` session hand the library key over on the same device, so a Badger signed in by email can sign in
 * a Parrot installed next to it with no codes.
 *
 * @req ACCT-PAIR-07
 */
const SUITE = "[sign-in-client-type]";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Badger desktop sign-in", () => {
  it("records its session as badger-desktop", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        bodies.push((await request.clone().json().catch(() => ({}))) as Record<string, unknown>);
        console.info(SUITE, "request", request.method, request.url);
        return new Response(JSON.stringify({ token: "t", user: { id: "u", email: "a@b.c" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    vi.stubGlobal("window", {});
    // Loaded after the window stub: the renderer module reads `window` when it loads.
    const { login } = await import("../src/renderer/src/api");
    // The renderer resolves its API base from Vite's env; none in a unit test.
    setApiBaseUrl("http://api.test");
    await login("a@b.c", "password-123").catch((err: unknown) => console.info(SUITE, "login settled with", String(err)));
    console.info(SUITE, "bodies", bodies);
    expect(bodies[0]?.clientType).toBe("badger-desktop");
  });
});
