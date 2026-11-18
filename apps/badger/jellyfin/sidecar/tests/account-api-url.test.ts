import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadIntegrationConfig, PRODUCTION_API_URL } from "../src/config";
import { IntegrationRuntime } from "../src/runtime";

const phase = (name: string, detail = "") => console.info(`[jellyfin-account-api-url] phase: ${name}${detail ? ` ${detail}` : ""}`);

// The plugin's ApiUrl setting (HEADLESS_API_URL) and the address a saved session remembers count on a dev run only;
// any other run talks to the production API, the one whose ticket key it trusts.
describe("account API address outside dev mode", () => {
  const dirs: string[] = [];
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const stateDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-intg-apiurl-"));
    dirs.push(dir);
    const state = path.join(dir, "state");
    fs.mkdirSync(state, { recursive: true });
    return { dir, state };
  };

  // @req ACCT-AUTH-09
  it("a release run ignores HEADLESS_API_URL; a dev run (HEADLESS_DEV_TICKET_KEY=1) honours it", () => {
    phase("release", "HEADLESS_API_URL set, no dev switch");
    const release = loadIntegrationConfig({ HEADLESS_API_URL: "http://dev.lan:3000/" });
    expect(release.devTicketKey).toBe(false);
    expect(release.apiUrl).toBe(PRODUCTION_API_URL);
    phase("dev", "same address with the dev switch");
    const dev = loadIntegrationConfig({ HEADLESS_API_URL: "http://dev.lan:3000/", HEADLESS_DEV_TICKET_KEY: "1" });
    expect(dev.apiUrl).toBe("http://dev.lan:3000");
    phase("dev-default", "dev switch without an address");
    expect(loadIntegrationConfig({ HEADLESS_DEV_TICKET_KEY: "1" }).apiUrl).toBe(PRODUCTION_API_URL);
  });

  // @req ACCT-AUTH-09
  it("a release run ignores a stale saved session address and a requested sign-in address, and signs in against production", async () => {
    const { dir, state } = stateDir();
    fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ token: "t", email: "a@b.c", userId: "u", apiUrl: "http://dev.lan:3000" }));
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config = loadIntegrationConfig({
      HEADLESS_STATE_DIR: state,
      HEADLESS_LIBRARY_KEY_FILE: path.join(dir, "library.key"),
      HEADLESS_API_URL: "http://dev.lan:3000",
    });
    const runtime = new IntegrationRuntime(config, () => undefined);
    phase("load-auth", "saved session remembers a dev address");
    expect((await (runtime as unknown as { loadAuth(): Promise<{ apiUrl: string } | null> }).loadAuth())?.apiUrl).toBe(PRODUCTION_API_URL);

    phase("login", "the dashboard asks for a dev address");
    await expect(runtime.login({ email: "a@b.c", password: "pw", apiUrl: "http://dev.lan:3000" })).rejects.toBeTruthy();
    expect(seen).toContain(`${PRODUCTION_API_URL}/auth/login`);
    expect(seen.some((url) => url.startsWith("http://dev.lan"))).toBe(false);
  });

  // @req ACCT-AUTH-09
  it("a dev run keeps the saved session address and the requested sign-in address", async () => {
    const { dir, state } = stateDir();
    fs.writeFileSync(path.join(state, "auth.json"), JSON.stringify({ token: "t", email: "a@b.c", userId: "u", apiUrl: "http://dev.lan:3000/" }));
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config = loadIntegrationConfig({
      HEADLESS_STATE_DIR: state,
      HEADLESS_LIBRARY_KEY_FILE: path.join(dir, "library.key"),
      HEADLESS_DEV_TICKET_KEY: "1",
    });
    const runtime = new IntegrationRuntime(config, () => undefined);
    phase("load-auth", "dev run");
    expect((await (runtime as unknown as { loadAuth(): Promise<{ apiUrl: string } | null> }).loadAuth())?.apiUrl).toBe("http://dev.lan:3000");
    phase("login", "dev address requested");
    await expect(runtime.login({ email: "a@b.c", password: "pw", apiUrl: "http://other.lan:3000" })).rejects.toBeTruthy();
    expect(seen).toContain("http://other.lan:3000/auth/login");
  });
});
