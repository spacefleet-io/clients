/**
 * REL-UPD-07: the minimal D-Bus client the Flatpak self-update talks to the portal with
 * (packages/desktop-shell/src/updater/dbus.ts): the wire format both ways, the bus address, and a real connection to a
 * fake bus on a unix socket (SASL EXTERNAL, Hello, a call, an error reply, a signal, an incoming call, the bus closing).
 *
 * Diagnostic logging: `[dbus:<phase>]` lines with what the fake bus received.
 */
// @req REL-UPD-07[badger-desktop,parrot]
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectSessionBus,
  DBusError,
  decodeMessage,
  encodeMessage,
  marshalBody,
  MESSAGE_TYPE,
  messageLength,
  parseBusAddress,
  splitSignature,
  variant,
  type DBusMessage,
} from "../src/updater/dbus";

const SUITE = "dbus";

describe("D-Bus wire format", () => {
  it("splits signatures into complete types", () => {
    expect(splitSignature("sa{sv}u")).toEqual(["s", "a{sv}", "u"]);
    expect(splitSignature("ayaaya{uh}a{ss}ua{sv}")).toEqual(["ay", "aay", "a{uh}", "a{ss}", "u", "a{sv}"]);
    expect(splitSignature("a(yv)(si)")).toEqual(["a(yv)", "(si)"]);
    expect(() => splitSignature("a{sv")).toThrow(/unclosed/);
    expect(() => splitSignature("z")).toThrow(/not supported/);
  });

  it("a message round-trips: header fields, strings, byte arrays, dicts of variants, numbers", () => {
    const body = [
      Buffer.from("/\0"),
      [Buffer.from("sh\0"), Buffer.from("-c\0")],
      { op: variant("u", 1), n_ops: variant("u", 2), error: variant("s", "boom"), ok: variant("b", true) },
      42,
      -7,
      2n ** 40n,
      [
        [1, "x"],
        [2, "yz"],
      ],
    ];
    const signature = "ayaaya{sv}uixa(us)";
    const wire = encodeMessage({
      type: MESSAGE_TYPE.signal,
      flags: 0,
      serial: 9,
      path: "/org/freedesktop/portal/Flatpak/update_monitor/1_42/sf1",
      interface: "org.freedesktop.portal.Flatpak.UpdateMonitor",
      member: "Progress",
      sender: ":1.5",
      signature,
      body,
    });
    expect(messageLength(wire)).toBe(wire.length);
    expect(messageLength(wire.subarray(0, wire.length - 1))).toBeNull();
    expect(messageLength(wire.subarray(0, 10))).toBeNull();
    const decoded = decodeMessage(wire);
    console.info(`[${SUITE}:roundtrip] bytes=${wire.length} ${JSON.stringify({ ...decoded, body: undefined }, null, 0)}`);
    expect(decoded).toMatchObject({
      type: MESSAGE_TYPE.signal,
      serial: 9,
      path: "/org/freedesktop/portal/Flatpak/update_monitor/1_42/sf1",
      interface: "org.freedesktop.portal.Flatpak.UpdateMonitor",
      member: "Progress",
      sender: ":1.5",
      signature,
    });
    const [cwd, argv, dict, u, i, x, structs] = decoded.body;
    expect(cwd).toEqual(Buffer.from("/\0"));
    expect(argv).toEqual([Buffer.from("sh\0"), Buffer.from("-c\0")]);
    // Variants decode to their value.
    expect(dict).toEqual({ op: 1, n_ops: 2, error: "boom", ok: true });
    expect([u, i, BigInt(x as bigint)]).toEqual([42, -7, 2n ** 40n]);
    expect(structs).toEqual([
      [1, "x"],
      [2, "yz"],
    ]);
  });

  it("the body alone, aligned from its start", () => {
    // "s" then "u": 4-byte length + "ab\0", padded to 8, then the uint32.
    expect([...marshalBody("su", ["ab", 1])]).toEqual([2, 0, 0, 0, 0x61, 0x62, 0, 0, 1, 0, 0, 0]);
  });

  it("bus addresses: path, abstract, escapes, the first unix one", () => {
    expect(parseBusAddress("unix:path=/run/flatpak/bus")).toBe("/run/flatpak/bus");
    expect(parseBusAddress("unix:path=/run/user/1000/bus,guid=abc")).toBe("/run/user/1000/bus");
    expect(parseBusAddress("unix:abstract=/tmp/dbus-XYZ,guid=1")).toBe("\0/tmp/dbus-XYZ");
    expect(parseBusAddress("tcp:host=localhost,port=1;unix:path=/tmp/a%20b")).toBe("/tmp/a b");
    expect(() => parseBusAddress("tcp:host=localhost,port=1")).toThrow(/no unix socket/);
  });
});

/** A fake session bus on a unix socket: SASL, then each method call goes to `handle`, which writes the answers. */
const startFakeBus = async (handle: (message: DBusMessage, socket: Socket, reply: (m: Parameters<typeof encodeMessage>[0]) => void) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "sf-dbus-"));
  const path = join(dir, "bus");
  const received: string[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let authed = false;
    let buf = Buffer.alloc(0);
    let serial = 100;
    const reply = (m: Parameters<typeof encodeMessage>[0]) => socket.write(encodeMessage({ ...m, serial: ++serial }));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!authed) {
        const text = buf.toString("latin1");
        const auth = text.indexOf("\r\n");
        if (auth !== -1 && !text.includes("BEGIN\r\n")) {
          if (!received.includes("AUTH")) {
            received.push(text.slice(0, auth).startsWith("\0AUTH EXTERNAL ") ? "AUTH" : `bad:${text.slice(0, auth)}`);
            socket.write("OK 0123456789abcdef\r\n");
          }
          return;
        }
        const begin = text.indexOf("BEGIN\r\n");
        if (begin === -1) return;
        authed = true;
        received.push("BEGIN");
        buf = buf.subarray(begin + "BEGIN\r\n".length);
      }
      for (let length = messageLength(buf); length !== null; length = messageLength(buf)) {
        const message = decodeMessage(buf.subarray(0, length));
        buf = buf.subarray(length);
        received.push(`${message.type}:${message.member ?? message.errorName}`);
        if (message.member === "Hello") {
          reply({ type: MESSAGE_TYPE.methodReturn, flags: 0, serial: 0, replySerial: message.serial, destination: ":1.77", signature: "s", body: [":1.77"] });
        } else handle(message, socket, reply);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return {
    address: `unix:path=${path},guid=0123`,
    received,
    sockets,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("D-Bus connection (fake bus on a unix socket)", () => {
  it("authenticates, says Hello, calls, gets errors as DBusError, receives signals, answers incoming calls, ends", async () => {
    const bus = await startFakeBus((message, _socket, reply) => {
      if (message.member === "Get") {
        reply({ type: MESSAGE_TYPE.methodReturn, flags: 0, serial: 0, replySerial: message.serial, signature: "v", body: [variant("u", 8)] });
      } else if (message.member === "Update") {
        reply({
          type: MESSAGE_TYPE.signal,
          flags: 0,
          serial: 0,
          path: "/m",
          interface: "org.freedesktop.portal.Flatpak.UpdateMonitor",
          member: "Progress",
          signature: "a{sv}",
          body: [{ status: variant("u", 2) }],
        });
        reply({
          type: MESSAGE_TYPE.error,
          flags: 0,
          serial: 0,
          replySerial: message.serial,
          errorName: "org.freedesktop.DBus.Error.AccessDenied",
          signature: "s",
          body: ["Application update not allowed"],
        });
        // The bus pings the client: it must answer with an error, never stay silent.
        reply({ type: MESSAGE_TYPE.methodCall, flags: 0, serial: 0, path: "/", interface: "org.freedesktop.DBus.Peer", member: "Ping", sender: "org.freedesktop.DBus" });
      }
    });
    cleanup = bus.stop;
    const connection = await connectSessionBus(bus.address);
    expect(connection.uniqueName).toBe(":1.77");
    expect(await connection.call({ destination: "d", path: "/p", interface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: ["i", "version"] })).toEqual([8]);
    const signals: DBusMessage[] = [];
    connection.onSignal((m) => signals.push(m));
    const denied = await connection.call({ destination: "d", path: "/m", interface: "i", member: "Update", signature: "sa{sv}", body: ["", {}] }).catch((err: unknown) => err);
    expect(denied).toBeInstanceOf(DBusError);
    expect((denied as DBusError).dbusName).toBe("org.freedesktop.DBus.Error.AccessDenied");
    expect((denied as DBusError).message).toBe("org.freedesktop.DBus.Error.AccessDenied: Application update not allowed");
    expect(signals.map((s) => [s.member, s.body[0]])).toEqual([["Progress", { status: 2 }]]);
    // Wait for the client's answer to the Ping to reach the fake bus.
    await expect.poll(() => bus.received.at(-1)).toBe(`${MESSAGE_TYPE.error}:org.freedesktop.DBus.Error.UnknownMethod`);
    const ended = Promise.withResolvers<Error | null>();
    connection.onClose(ended.resolve);
    const pending = connection.call({ destination: "d", path: "/p", interface: "i", member: "Never" }).catch((err: unknown) => err);
    // The bus hangs up cleanly: the close reason is null and the call waiting for a reply fails.
    await expect.poll(() => bus.received.at(-1)).toBe("1:Never");
    for (const s of bus.sockets) s.end();
    expect(await ended.promise).toBeNull();
    expect(await pending).toEqual(new Error("D-Bus connection closed"));
    await expect(connection.call({ destination: "d", path: "/p", interface: "i", member: "After" })).rejects.toThrow();
    console.info(`[${SUITE}:connection] received=${JSON.stringify(bus.received)}`);
    expect(bus.received.slice(0, 4)).toEqual(["AUTH", "BEGIN", "1:Hello", "1:Get"]);
  });

  it("a refused authentication rejects and closes the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-dbus-"));
    const path = join(dir, "bus");
    const closed = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      socket.once("data", () => socket.write("REJECTED EXTERNAL\r\n"));
      socket.on("close", () => closed.resolve());
    });
    await new Promise<void>((r) => server.listen(path, r));
    cleanup = async () => {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    };
    await expect(connectSessionBus(`unix:path=${path}`)).rejects.toThrow("D-Bus authentication refused: REJECTED EXTERNAL");
    await closed.promise;
  });

  it("no address, no socket: rejects", async () => {
    await expect(connectSessionBus("")).rejects.toThrow("DBUS_SESSION_BUS_ADDRESS is not set");
    await expect(connectSessionBus("unix:path=/nonexistent/sf-dbus-test")).rejects.toThrow(/ENOENT/);
  });
});
