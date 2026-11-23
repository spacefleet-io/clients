/**
 * @level unit
 * The new-device client names the app asking to sign in: every call carries `x-space-app: <appId>`, so the API stores
 * it, the approver reads "<App> on <device> wants to sign in" and the session becomes `<appId>-<deviceType>`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  commitmentOpens,
  createPairingClientCore,
  fingerprintFromLink,
  fingerprintMatches,
  lookupPairingRequest,
  pairingCheckCode,
  runPairingCheck,
  type ApprovePairingDeps,
} from "../src";

/** @req ACCT-PAIR-05 */
describe("[pairing-client] x-space-app", () => {
  const run = async (appId: "parrot" | "badger") => {
    const seen: Array<{ method: string; path: string; app: string | null }> = [];
    const fetchImpl = (async (request: Request) => {
      const path = new URL(request.url).pathname;
      seen.push({ method: request.method, path, app: request.headers.get("x-space-app") });
      if (request.method === "POST") {
        return Response.json(
          { requestId: "req-1", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      return Response.json({ status: "pending" });
    }) as unknown as typeof fetch;
    const core = createPairingClientCore({
      appId,
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "Studio laptop",
      fallbackDeviceName: "Computer",
      fetchImpl,
    });
    const created = await core.start();
    const polled = await core.poll(created.requestId);
    console.info(`[pairing-client-${appId}]`, { seen, polled: polled.status });
    return { seen, polled };
  };

  it("[pairing-client-1] a Parrot client sends x-space-app: parrot on the request and the poll", async () => {
    const { seen, polled } = await run("parrot");
    expect(polled.status).toBe("pending");
    expect(seen.map((call) => [call.method, call.path, call.app])).toEqual([
      ["POST", "/pairing/requests", "parrot"],
      ["GET", "/pairing/requests/req-1", "parrot"],
    ]);
  });

  it("[pairing-client-2] a Badger client sends x-space-app: badger", async () => {
    const { seen } = await run("badger");
    expect(seen.every((call) => call.app === "badger")).toBe(true);
  });
});

/**
 * PRIV-PAIR-01 / PRIV-PAIR-03: the receiving core against a fake API that only relays, and the real approver core on the
 * other side. Both screens must show the same six digits; leaving the screen deletes the request.
 */
describe("[pair-v2-client] check code and cancel", () => {
  type Row = { publicKey: string; commitment: string; approverNonce: string | null; requesterNonce: string | null };
  const setup = () => {
    const rows = new Map<string, Row>();
    const seen: string[] = [];
    const fetchImpl = (async (request: Request) => {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/pairing/requests") {
        const body = (await request.json()) as { publicKey: string; commitment: string };
        rows.set("req-1", { publicKey: body.publicKey, commitment: body.commitment, approverNonce: null, requesterNonce: null });
        return Response.json(
          { requestId: "req-1", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      const row = rows.get("req-1");
      if (!row) return Response.json({ error: "pairing_not_found" }, { status: 404 });
      if (request.method === "POST" && url.pathname === "/pairing/requests/req-1/reveal") {
        const body = (await request.json()) as { pollSecret: string; requesterNonce: string };
        row.requesterNonce = body.requesterNonce;
        return Response.json({ ok: true });
      }
      if (request.method === "DELETE") {
        expect(url.searchParams.get("pollSecret")).toBe("s");
        rows.delete("req-1");
        return Response.json({ ok: true });
      }
      return Response.json(row.approverNonce ? { status: "pending", approverNonce: row.approverNonce } : { status: "pending" });
    }) as unknown as typeof fetch;
    const core = createPairingClientCore({
      appId: "badger",
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "Studio laptop",
      fallbackDeviceName: "Computer",
      fetchImpl,
    });
    const approverDeps: ApprovePairingDeps = {
      lookup: async () => {
        const row = rows.get("req-1")!;
        return { requestId: "req-1", deviceType: "desktop", deviceName: "Studio laptop", publicKey: row.publicKey, protocol: 2, commitment: row.commitment, expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      approve: async () => ({ ok: true }),
      deny: async () => ({ ok: true }),
      getLibraryKey: async () => "key",
      keyOpensAccount: async () => true,
      connect: async (_token, _id, nonce) => {
        rows.get("req-1")!.approverNonce = nonce;
        return { ok: true };
      },
      readReveal: async () => {
        const row = rows.get("req-1");
        if (!row) return { status: "expired" };
        return row.requesterNonce ? { status: "pending", requesterNonce: row.requesterNonce } : { status: "pending" };
      },
      now: () => Date.now(),
    };
    return { rows, seen, core, approverDeps };
  };

  it("@req PRIV-PAIR-01 [pair-v2-client-1] the device commits, reveals after the connect and shows the approver's code", async () => {
    const { rows, core, approverDeps } = setup();
    const created = await core.start();
    const row = rows.get("req-1")!;
    // The QR link carries the commitment's fingerprint, written by the device.
    expect(fingerprintMatches(fingerprintFromLink(created.qrPayload), row.commitment)).toBe(true);
    expect(await core.poll("req-1")).toEqual({ status: "pending" });

    const found = await lookupPairingRequest(approverDeps, "tok", created.shortCode);
    // The approver waits for the reveal while the device keeps polling.
    const checking = runPairingCheck(approverDeps, "tok", found, created.qrPayload, async () => {
      await core.poll("req-1");
    });
    const checked = await checking;
    const devicePoll = await core.poll("req-1");
    console.info("[pair-v2-client-1]", { approver: checked.check, device: devicePoll, link: created.qrPayload });
    expect(commitmentOpens(row.commitment, row.publicKey, row.requesterNonce!)).toBe(true);
    expect(devicePoll).toEqual({ status: "pending", checkCode: checked.check.code });
    expect(checked.check.confirmedByQr).toBe(true);
  });

  it("@req PRIV-PAIR-03 [pair-v2-client-2] leaving the screen deletes the request on the API", async () => {
    const { rows, seen, core } = setup();
    await core.start();
    core.cancel();
    // cancel() fires the DELETE without waiting; wait for the fake API to see it.
    await vi.waitFor(() => expect(seen).toContain("DELETE /pairing/requests/req-1"));
    console.info("[pair-v2-client-2]", seen);
    expect(rows.has("req-1")).toBe(false);
    expect(await core.poll("req-1")).toEqual({ status: "expired" });
  });

  /**
   * Found by the sf-pair-v2 TLA+ model (FormalPairing): a server that takes the reveal (learns the device's number) but
   * answers 500, then shows a different approver number, could grind that number until the device's code equals a code
   * it controls on the approver. The device pins the first approver number before the reveal is sent.
   */
  it("@req PRIV-PAIR-01 [pair-v2-client-3] a failed reveal does not let the server swap the approver number", async () => {
    const nA1 = "A".repeat(43);
    const nA2 = "B".repeat(43);
    let shownNonce = nA1;
    let reveals = 0;
    let row: { publicKey: string; commitment: string; requesterNonce: string | null } | null = null;
    const fetchImpl = (async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/pairing/requests") {
        const body = (await request.json()) as { publicKey: string; commitment: string };
        row = { publicKey: body.publicKey, commitment: body.commitment, requesterNonce: null };
        return Response.json(
          { requestId: "req-1", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      if (request.method === "POST" && url.pathname === "/pairing/requests/req-1/reveal") {
        reveals += 1;
        row!.requesterNonce = ((await request.json()) as { requesterNonce: string }).requesterNonce;
        // The lying server keeps the number, fails the answer, and shows another approver number from now on.
        if (reveals === 1) {
          shownNonce = nA2;
          return Response.json({ error: "internal" }, { status: 500 });
        }
        return Response.json({ ok: true });
      }
      return Response.json({ status: "pending", approverNonce: shownNonce });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const core = createPairingClientCore({
      appId: "badger",
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "Studio laptop",
      fallbackDeviceName: "Computer",
      fetchImpl,
      log: (message) => logs.push(message),
    });
    await core.start();
    const first = await core.poll("req-1");
    const second = await core.poll("req-1");
    const codeFor = (approverNonce: string) =>
      pairingCheckCode({ publicKey: row!.publicKey, commitment: row!.commitment, approverNonce, requesterNonce: row!.requesterNonce! });
    console.info("[pair-v2-client-3]", { first, second, reveals, logs, codeA1: codeFor(nA1), codeA2: codeFor(nA2) });
    expect(first).toEqual({ status: "pending" });
    expect(second).toEqual({ status: "pending", checkCode: codeFor(nA1) });
    expect(second).not.toEqual({ status: "pending", checkCode: codeFor(nA2) });
    expect(logs).toContain("pairing approver number changed; ignored, the first one stays");
  });

  it("@req PRIV-PAIR-01 [pair-v2-client-4] two polls racing different approver numbers both use the first", async () => {
    let row: { publicKey: string; commitment: string; requesterNonce: string | null } | null = null;
    const nonces = ["C".repeat(43), "D".repeat(43)];
    let polls = 0;
    const fetchImpl = (async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/pairing/requests") {
        const body = (await request.json()) as { publicKey: string; commitment: string };
        row = { publicKey: body.publicKey, commitment: body.commitment, requesterNonce: null };
        return Response.json(
          { requestId: "req-1", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      if (request.method === "POST" && url.pathname === "/pairing/requests/req-1/reveal") {
        row!.requesterNonce = ((await request.json()) as { requesterNonce: string }).requesterNonce;
        return Response.json({ ok: true });
      }
      const approverNonce = nonces[Math.min(polls, 1)]!;
      polls += 1;
      return Response.json({ status: "pending", approverNonce });
    }) as unknown as typeof fetch;
    const core = createPairingClientCore({
      appId: "badger",
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "Studio laptop",
      fallbackDeviceName: "Computer",
      fetchImpl,
    });
    await core.start();
    const [a, b] = await Promise.all([core.poll("req-1"), core.poll("req-1")]);
    const expected = pairingCheckCode({ publicKey: row!.publicKey, commitment: row!.commitment, approverNonce: nonces[0]!, requesterNonce: row!.requesterNonce! });
    console.info("[pair-v2-client-4]", { a, b, expected });
    expect(a).toEqual({ status: "pending", checkCode: expected });
    expect(b).toEqual({ status: "pending", checkCode: expected });
  });
});
