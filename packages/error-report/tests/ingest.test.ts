/**
 * @test-id error-report-ingest
 * @level integration
 *
 * A real Sentry SDK (the Node one, which shares its core and its `beforeSend`
 * contract with the Electron and React Native SDKs) reports to a local server
 * that stands in for the Bugsink ingest address.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createErrorReporting, createReporterOptions } from "../src";

const APPS = "[badger-desktop,badger-mobile]";

interface Received {
  url: string;
  body: string;
}

let server: Server;
let dsn = "";
const received: Received[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    received.push({ url: req.url ?? "", body: await readBody(req) });
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  dsn = `http://publickey@127.0.0.1:${(server.address() as AddressInfo).port}/1`;
  console.info("[ingest-test] fake ingest at", dsn);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const sdk = {
  start() {
    Sentry.init({ ...createReporterOptions({ dsn, release: "9.9.9" }), defaultIntegrations: false, integrations: [] });
  },
  async stop() {
    await Sentry.close(2000);
  },
};

function forcedError() {
  const error = new Error("ENOENT: no such file or directory, open '/home/chris/Videos/Blade Runner 2049.mkv'");
  error.stack = `Error: ${error.message}\n    at openMedia (/home/chris/.local/share/badger/resources/app.asar/out/main/index-3f9a.js:120:7)`;
  Sentry.captureException(error, { user: { id: "u_1", email: "chris@example.com" }, tags: { title: "Blade Runner 2049" }, extra: { title: "Blade Runner 2049" } });
}

describe("opt-in gates the ingest host", () => {
  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} makes no network call to the ingest host until the user opts in`, async () => {
    const reporting = createErrorReporting(sdk);

    forcedError();
    await Sentry.flush(1000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.info("[ingest-test] opted out: requests =", received.length);
    expect(reporting.isEnabled()).toBe(false);
    expect(received).toHaveLength(0);
  });

  // @req REL-LOG-06[badger-desktop,badger-mobile]
  it(`@req REL-LOG-06${APPS} sends a scrubbed error to the ingest host once the user opts in, and stops when they opt out`, async () => {
    const reporting = createErrorReporting(sdk);

    await reporting.setEnabled(true);
    forcedError();
    await Sentry.flush(3000);
    console.info("[ingest-test] opted in: requests =", received.map((r) => r.url));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const envelope = received.find((r) => r.url.includes("/api/1/envelope"));
    expect(envelope, "an envelope reached the ingest endpoint").toBeDefined();
    const body = envelope!.body;
    console.info("[ingest-test] envelope:", body);
    expect(body).toContain("ENOENT");
    expect(body).toContain('"release":"9.9.9"');
    for (const leaked of ["/home/chris", "Blade Runner", ".mkv", "chris@example.com", "u_1", "app.asar"]) {
      expect(body, `leaked ${leaked}`).not.toContain(leaked);
    }

    await reporting.setEnabled(false);
    const before = received.length;
    forcedError();
    await Sentry.flush(1000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received.length).toBe(before);
  });
});
