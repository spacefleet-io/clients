import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient as generate } from "@hey-api/openapi-ts";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "../src";
import { sdkPlugins } from "../openapi-ts.config";

const root = fileURLToPath(new URL("..", import.meta.url));
const openapiPath = join(root, "../../apps/api/openapi.json");

type Doc = { paths: Record<string, Record<string, { operationId?: string }>> };
const doc = JSON.parse(readFileSync(openapiPath, "utf8")) as Doc;

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("SDK is generated from the published API description", () => {
  /** @req DEV-API-02[api] */
  it("regenerating from apps/api/openapi.json gives exactly the committed src/generated", async () => {
    const out = mkdtempSync(join(tmpdir(), "space-sdk-"));
    try {
      await generate({
        input: openapiPath,
        output: { path: out, clean: true },
        plugins: [...sdkPlugins],
        logs: { level: "silent" },
      });
      const committed = join(root, "src/generated");
      const fresh = listFiles(out).map((file) => relative(out, file)).sort();
      expect(listFiles(committed).map((file) => relative(committed, file)).sort()).toEqual(fresh);
      for (const file of fresh) {
        expect(readFileSync(join(committed, file), "utf8"), file).toBe(readFileSync(join(out, file), "utf8"));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  /** @req DEV-API-02[api] */
  it("exports one SDK function for every published operation", () => {
    const ids = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids) {
      expect(typeof (sdk as Record<string, unknown>)[id as string], String(id)).toBe("function");
    }
  });
});

describe("client", () => {
  /** @req DEV-API-02[api] */
  it("sends the bearer token and the app scope, and returns the typed body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { email: "a@b.c" }));
    const client = sdk.createSpaceClient({ baseUrl: "https://api.test/api/", appId: "parrot", token: "tok", fetch: fetchMock as never });
    const settings = await sdk.unwrap(sdk.getAccountSettings({ client }));
    expect(settings).toEqual({ email: "a@b.c" });
    const request = (fetchMock.mock.calls[0] as unknown as [Request])[0];
    expect(request.url).toBe("https://api.test/api/account/settings");
    expect(request.headers.get("authorization")).toBe("Bearer tok");
    expect(request.headers.get("x-space-app")).toBe("parrot");
  });

  /** @req DEV-API-02[api] */
  it("turns a non-2xx answer into ApiError(status, body)", async () => {
    const client = sdk.createSpaceClient({
      baseUrl: "https://api.test",
      fetch: (async () => jsonResponse(401, { error: "unauthorized" })) as never,
    });
    const failure = await sdk.unwrap(sdk.getAccountSettings({ client })).catch((error) => error);
    expect(failure).toBeInstanceOf(sdk.ApiError);
    expect(failure.status).toBe(401);
    expect(failure.message).toBe("unauthorized");
    expect(failure.payload).toEqual({ error: "unauthorized" });
  });

  /** @req DEV-API-02[api] */
  it("answers undefined for a 204", async () => {
    const client = sdk.createSpaceClient({ baseUrl: "https://api.test", fetch: (async () => new Response(null, { status: 204 })) as never });
    await expect(sdk.unwrap(sdk.logout({ client }))).resolves.toBeUndefined();
  });

  /** @req DEV-API-02[api] */
  it("rethrows the original fetch error when there is no response", async () => {
    const offline = new TypeError("Network request failed");
    const client = sdk.createSpaceClient({
      baseUrl: "https://api.test",
      fetch: (async () => {
        throw offline;
      }) as never,
    });
    const failure = await sdk.unwrap(sdk.getAccountSettings({ client })).catch((error) => error);
    expect(failure).toBe(offline);
  });

  /** @req DEV-API-02[api] */
  it("answers ApiError(0, no_response) when the transport failed with something that is not an Error", async () => {
    const client = sdk.createSpaceClient({
      baseUrl: "https://api.test",
      fetch: (async () => {
        throw "boom"; // eslint-disable-line @typescript-eslint/only-throw-error
      }) as never,
    });
    const failure = await sdk.unwrap(sdk.getAccountSettings({ client })).catch((error) => error);
    expect(failure).toBeInstanceOf(sdk.ApiError);
    expect(failure).toMatchObject({ status: 0, payload: { error: "no_response" } });
  });

  /** @req DEV-API-02[api] */
  it("rejects a 2xx whose JSON body does not parse", async () => {
    const client = sdk.createSpaceClient({
      baseUrl: "https://api.test",
      fetch: (async () => new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } })) as never,
    });
    const failure = await sdk.unwrap(sdk.getAccountSettings({ client })).catch((error) => error);
    expect(failure).toBeInstanceOf(SyntaxError);
  });

  /** @req DEV-API-02[api] */
  it("rejects a 2xx that is not JSON as invalid_response", async () => {
    for (const headers of [{ "Content-Type": "text/html" }, undefined]) {
      const client = sdk.createSpaceClient({
        baseUrl: "https://api.test",
        fetch: (async () => new Response("<html>captive portal</html>", { status: 200, headers })) as never,
      });
      const failure = await sdk.unwrap(sdk.getAccountSettings({ client })).catch((error) => error);
      expect(failure).toBeInstanceOf(sdk.ApiError);
      expect(failure).toMatchObject({ status: 200, payload: { error: "invalid_response" } });
    }
  });
});
