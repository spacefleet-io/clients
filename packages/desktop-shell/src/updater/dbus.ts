/**
 * A small D-Bus session-bus client for the main process (REL-UPD-07: the Flatpak's self update, flatpakPortal.ts).
 *
 * The Flatpak portal's `UpdateMonitor` sends its `Progress` signal to the one connection that created the monitor, and
 * closes the monitor when that connection leaves the bus, so the update needs one connection held for its whole
 * length: one-shot `gdbus call`s cannot do it. No D-Bus package is bundled for these few calls (the maintained ones pull
 * native code or have not had a release in years); this file speaks the wire protocol directly: SASL `EXTERNAL`
 * authentication over the bus's unix socket, `Hello`, method calls with their replies, and incoming signals.
 *
 * Values: numbers for `y n q i u h`, `bigint` for `x t`, `number` for `d`, booleans for `b`, strings for `s o g`, a
 * `Buffer` (or `Uint8Array`) for `ay`, arrays for other arrays and for structs, objects (or `[key, value]` pairs) for
 * dictionaries, and `{ signature, value }` (see `variant`) for a variant. A received variant is unwrapped to its value.
 */
import { createConnection, type Socket } from "node:net";

export type DBusVariant = { signature: string; value: unknown };
export const variant = (signature: string, value: unknown): DBusVariant => ({ signature, value });

/** An error reply (`name` is the D-Bus error name, e.g. `org.freedesktop.DBus.Error.AccessDenied`). */
export class DBusError extends Error {
  constructor(
    readonly dbusName: string,
    message: string,
  ) {
    super(message ? `${dbusName}: ${message}` : dbusName);
    this.name = "DBusError";
  }
}

export const MESSAGE_TYPE = { methodCall: 1, methodReturn: 2, error: 3, signal: 4 } as const;
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8, unixFds: 9 } as const;
const FIELD_SIGNATURE: Record<number, string> = { 1: "o", 2: "s", 3: "s", 4: "s", 5: "u", 6: "s", 7: "s", 8: "g", 9: "u" };
/** `NO_REPLY_EXPECTED` header flag. */
const FLAG_NO_REPLY = 0x1;

export type DBusMessage = {
  type: number;
  flags: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: unknown[];
};

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1 };

/** The end index (exclusive) of the one complete type that starts at `signature[start]`. */
const completeTypeEnd = (signature: string, start: number): number => {
  const c = signature[start];
  if (c === undefined) throw new Error(`D-Bus signature "${signature}" ends early`);
  if (c === "a") return completeTypeEnd(signature, start + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let i = start + 1;
    while (signature[i] !== close) {
      if (i >= signature.length) throw new Error(`D-Bus signature "${signature}" has an unclosed ${c}`);
      i = completeTypeEnd(signature, i);
    }
    return i + 1;
  }
  if (!(c in ALIGN)) throw new Error(`D-Bus type '${c}' is not supported (signature "${signature}")`);
  return start + 1;
};

/** The complete types of a signature (`"sa{sv}u"` → `["s", "a{sv}", "u"]`). */
export const splitSignature = (signature: string): string[] => {
  const types: string[] = [];
  for (let i = 0; i < signature.length; ) {
    const end = completeTypeEnd(signature, i);
    types.push(signature.slice(i, end));
    i = end;
  }
  return types;
};

class Writer {
  private chunks: Buffer[] = [];
  length = 0;

  constructor(private readonly origin = 0) {}

  private push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  align(n: number): void {
    const pad = (n - ((this.origin + this.length) % n)) % n;
    if (pad) this.push(Buffer.alloc(pad));
  }

  private fixed(size: number, write: (buf: Buffer) => void): void {
    this.align(size);
    const buf = Buffer.alloc(size);
    write(buf);
    this.push(buf);
  }

  u32(value: number): void {
    this.fixed(4, (b) => b.writeUInt32LE(value >>> 0));
  }

  private string(value: string, lengthBytes: 1 | 4): void {
    const bytes = Buffer.from(value, "utf8");
    if (lengthBytes === 4) this.u32(bytes.length);
    else this.push(Buffer.from([bytes.length]));
    this.push(bytes);
    this.push(Buffer.alloc(1));
  }

  write(type: string, value: unknown): void {
    const c = type[0];
    switch (c) {
      case "y":
        return this.push(Buffer.from([Number(value) & 0xff]));
      case "b":
        return this.u32(value ? 1 : 0);
      case "n":
        return this.fixed(2, (b) => b.writeInt16LE(Number(value)));
      case "q":
        return this.fixed(2, (b) => b.writeUInt16LE(Number(value)));
      case "i":
        return this.fixed(4, (b) => b.writeInt32LE(Number(value)));
      case "u":
      case "h":
        return this.u32(Number(value));
      case "x":
        return this.fixed(8, (b) => b.writeBigInt64LE(BigInt(value as bigint | number)));
      case "t":
        return this.fixed(8, (b) => b.writeBigUInt64LE(BigInt(value as bigint | number)));
      case "d":
        return this.fixed(8, (b) => b.writeDoubleLE(Number(value)));
      case "s":
      case "o":
        return this.string(String(value), 4);
      case "g":
        return this.string(String(value), 1);
      case "v": {
        const { signature, value: inner } = value as DBusVariant;
        this.string(signature, 1);
        return this.write(signature, inner);
      }
      case "(": {
        this.align(8);
        const fields = splitSignature(type.slice(1, -1));
        const values = value as unknown[];
        fields.forEach((field, i) => this.write(field, values[i]));
        return;
      }
      case "a":
        return this.array(type.slice(1), value);
      default:
        throw new Error(`D-Bus type '${c}' is not supported`);
    }
  }

  private array(element: string, value: unknown): void {
    this.u32(0);
    const lengthAt = this.chunks.length - 1;
    // The length counts the element bytes only, after the padding to the first element.
    this.align(ALIGN[element[0]!]!);
    const start = this.length;
    if (element[0] === "{") {
      const [keyType, valueType] = splitSignature(element.slice(1, -1));
      const entries = Array.isArray(value) ? (value as [unknown, unknown][]) : Object.entries(value as Record<string, unknown>);
      for (const [key, entry] of entries) {
        this.align(8);
        this.write(keyType!, key);
        this.write(valueType!, entry);
      }
    } else if (element === "y" && value instanceof Uint8Array) {
      this.push(Buffer.from(value));
    } else {
      for (const item of value as unknown[]) this.write(element, item);
    }
    this.chunks[lengthAt]!.writeUInt32LE(this.length - start);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  offset = 0;

  constructor(
    private readonly buf: Buffer,
    private readonly little: boolean,
    private readonly origin = 0,
    start = 0,
  ) {
    this.offset = start;
  }

  align(n: number): void {
    this.offset += (n - ((this.offset - this.origin) % n)) % n;
  }

  private need(size: number): void {
    if (this.offset + size > this.buf.length) throw new Error("D-Bus message is shorter than its contents");
  }

  u32(): number {
    this.align(4);
    this.need(4);
    const v = this.little ? this.buf.readUInt32LE(this.offset) : this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  private string(lengthBytes: 1 | 4): string {
    let length: number;
    if (lengthBytes === 4) length = this.u32();
    else {
      this.need(1);
      length = this.buf[this.offset++]!;
    }
    this.need(length + 1);
    const s = this.buf.toString("utf8", this.offset, this.offset + length);
    this.offset += length + 1;
    return s;
  }

  private fixed<T>(size: number, little: (b: Buffer, o: number) => T, big: (b: Buffer, o: number) => T): T {
    this.align(size);
    this.need(size);
    const v = this.little ? little(this.buf, this.offset) : big(this.buf, this.offset);
    this.offset += size;
    return v;
  }

  read(type: string): unknown {
    const c = type[0];
    switch (c) {
      case "y":
        this.need(1);
        return this.buf[this.offset++];
      case "b":
        return this.u32() !== 0;
      case "n":
        return this.fixed(2, (b, o) => b.readInt16LE(o), (b, o) => b.readInt16BE(o));
      case "q":
        return this.fixed(2, (b, o) => b.readUInt16LE(o), (b, o) => b.readUInt16BE(o));
      case "i":
        return this.fixed(4, (b, o) => b.readInt32LE(o), (b, o) => b.readInt32BE(o));
      case "u":
      case "h":
        return this.u32();
      case "x":
        return this.fixed(8, (b, o) => b.readBigInt64LE(o), (b, o) => b.readBigInt64BE(o));
      case "t":
        return this.fixed(8, (b, o) => b.readBigUInt64LE(o), (b, o) => b.readBigUInt64BE(o));
      case "d":
        return this.fixed(8, (b, o) => b.readDoubleLE(o), (b, o) => b.readDoubleBE(o));
      case "s":
      case "o":
        return this.string(4);
      case "g":
        return this.string(1);
      case "v":
        return this.read(this.string(1));
      case "(": {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((field) => this.read(field));
      }
      case "a":
        return this.array(type.slice(1));
      default:
        throw new Error(`D-Bus type '${c}' is not supported`);
    }
  }

  private array(element: string): unknown {
    const length = this.u32();
    this.align(ALIGN[element[0]!]!);
    const end = this.offset + length;
    this.need(length);
    if (element === "y") {
      const bytes = Buffer.from(this.buf.subarray(this.offset, end));
      this.offset = end;
      return bytes;
    }
    if (element[0] === "{") {
      const [keyType, valueType] = splitSignature(element.slice(1, -1));
      const dict: Record<string, unknown> = {};
      while (this.offset < end) {
        this.align(8);
        const key = this.read(keyType!);
        dict[String(key)] = this.read(valueType!);
      }
      return dict;
    }
    const items: unknown[] = [];
    while (this.offset < end) items.push(this.read(element));
    return items;
  }
}

/** The values of `signature` as a message body (little-endian, aligned from the body's start, which is 8-aligned). */
export const marshalBody = (signature: string, body: readonly unknown[]): Buffer => {
  const w = new Writer();
  splitSignature(signature).forEach((type, i) => w.write(type, body[i]));
  return w.toBuffer();
};

/** One whole message on the wire. */
export const encodeMessage = (message: Omit<DBusMessage, "body" | "signature"> & { signature?: string; body?: readonly unknown[] }): Buffer => {
  const signature = message.signature ?? "";
  const body = signature ? marshalBody(signature, message.body ?? []) : Buffer.alloc(0);
  const fields: [number, DBusVariant][] = [];
  const add = (code: number, value: string | number | undefined): void => {
    if (value !== undefined) fields.push([code, variant(FIELD_SIGNATURE[code]!, value)]);
  };
  add(FIELD.path, message.path);
  add(FIELD.interface, message.interface);
  add(FIELD.member, message.member);
  add(FIELD.errorName, message.errorName);
  add(FIELD.replySerial, message.replySerial);
  add(FIELD.destination, message.destination);
  add(FIELD.sender, message.sender);
  if (signature) add(FIELD.signature, signature);
  const header = new Writer();
  header.write("y", "l".charCodeAt(0));
  header.write("y", message.type);
  header.write("y", message.flags);
  header.write("y", 1);
  header.u32(body.length);
  header.u32(message.serial);
  header.write("a(yv)", fields);
  header.align(8);
  return Buffer.concat([header.toBuffer(), body]);
};

/** The length of the first message in `buf`, or null when `buf` does not hold all of it yet. */
export const messageLength = (buf: Buffer): number | null => {
  if (buf.length < 16) return null;
  const little = buf[0] === 0x6c;
  const bodyLength = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLength = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLength = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8);
  const total = headerLength + bodyLength;
  return buf.length >= total ? total : null;
};

/** Reads one whole message (see `messageLength`). */
export const decodeMessage = (buf: Buffer): DBusMessage => {
  const little = buf[0] === 0x6c;
  if (!little && buf[0] !== 0x42) throw new Error(`D-Bus message has an unknown byte order 0x${buf[0]?.toString(16)}`);
  const r = new Reader(buf, little, 0, 4);
  r.u32(); // body length, see messageLength
  const serial = r.u32();
  const fields = r.read("a(yv)") as [number, unknown][];
  r.align(8);
  const message: DBusMessage = { type: buf[1]!, flags: buf[2]!, serial, signature: "", body: [] };
  for (const [code, value] of fields) {
    if (code === FIELD.path) message.path = value as string;
    else if (code === FIELD.interface) message.interface = value as string;
    else if (code === FIELD.member) message.member = value as string;
    else if (code === FIELD.errorName) message.errorName = value as string;
    else if (code === FIELD.replySerial) message.replySerial = value as number;
    else if (code === FIELD.destination) message.destination = value as string;
    else if (code === FIELD.sender) message.sender = value as string;
    else if (code === FIELD.signature) message.signature = value as string;
  }
  if (message.signature) {
    const body = new Reader(buf, little, r.offset, r.offset);
    message.body = splitSignature(message.signature).map((type) => body.read(type));
  }
  return message;
};

export type DBusCall = {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: readonly unknown[];
};

/** A live bus connection: method calls, the signals it receives, and its end. */
export type DBusConnection = {
  /** This connection's unique name (`:1.42`). */
  readonly uniqueName: string;
  /** Resolves the reply's body; rejects with `DBusError` on an error reply, or when the connection ends first. */
  call: (call: DBusCall) => Promise<unknown[]>;
  /** Every signal this connection receives; returns the unsubscribe. */
  onSignal: (listener: (message: DBusMessage) => void) => () => void;
  /** Runs once when the connection ends (closed here, or by the bus). */
  onClose: (listener: (reason: Error | null) => void) => void;
  close: () => void;
};

/** `unix:path=/run/user/1000/bus` / `unix:abstract=/tmp/dbus-…` (the first one a unix transport this side can open). */
export const parseBusAddress = (address: string): string => {
  for (const entry of address.split(";")) {
    const [transport, params = ""] = entry.split(/:(.*)/s);
    if (transport !== "unix") continue;
    const values = Object.fromEntries(
      params
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [key, value = ""] = pair.split(/=(.*)/s);
          return [key, decodeURIComponent(value)];
        }),
    );
    if (values.path) return values.path;
    if (values.abstract) return `\0${values.abstract}`;
  }
  throw new Error(`no unix socket in the D-Bus address "${address}"`);
};

const AUTH_TIMEOUT_MS = 10_000;

/** Connects to the session bus (`DBUS_SESSION_BUS_ADDRESS`; in a Flatpak the proxied `unix:path=/run/flatpak/bus`). */
export const connectSessionBus = async (address: string | undefined = process.env.DBUS_SESSION_BUS_ADDRESS): Promise<DBusConnection> => {
  if (!address) throw new Error("DBUS_SESSION_BUS_ADDRESS is not set");
  const socket = createConnection(parseBusAddress(address));
  const connected = Promise.withResolvers<void>();
  socket.once("connect", connected.resolve);
  socket.once("error", connected.reject);
  await connected.promise;
  socket.off("error", connected.reject);
  try {
    await authenticate(socket);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const connection = attach(socket);
  try {
    const [uniqueName] = await connection.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "Hello",
    });
    return { ...connection, uniqueName: String(uniqueName) };
  } catch (err) {
    connection.close();
    throw err;
  }
};

/** SASL `EXTERNAL`: the bus reads the uid from the socket's credentials; the client names the same uid. */
const authenticate = (socket: Socket): Promise<void> => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let received = "";
  const timer = setTimeout(() => done(new Error("D-Bus authentication timed out")), AUTH_TIMEOUT_MS);
  const onData = (chunk: Buffer): void => {
    received += chunk.toString("latin1");
    const end = received.indexOf("\r\n");
    if (end === -1) return;
    const line = received.slice(0, end);
    if (line.startsWith("OK ")) {
      socket.write("BEGIN\r\n");
      done(null);
    } else done(new Error(`D-Bus authentication refused: ${line}`));
  };
  const onError = (err: Error): void => done(err);
  const done = (err: Error | null): void => {
    clearTimeout(timer);
    socket.off("data", onData);
    socket.off("error", onError);
    if (err) reject(err);
    else resolve();
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid), "ascii").toString("hex")}\r\n`);
  return promise;
};

const attach = (socket: Socket): DBusConnection => {
  let serial = 0;
  let pending: Buffer = Buffer.alloc(0);
  let ended: Error | null | undefined;
  const replies = new Map<number, { resolve: (body: unknown[]) => void; reject: (err: Error) => void }>();
  const signalListeners = new Set<(message: DBusMessage) => void>();
  const closeListeners: ((reason: Error | null) => void)[] = [];

  const end = (reason: Error | null): void => {
    if (ended !== undefined) return;
    ended = reason;
    const err = reason ?? new Error("D-Bus connection closed");
    for (const { reject } of replies.values()) reject(err);
    replies.clear();
    for (const listener of closeListeners) listener(reason);
  };

  const dispatch = (message: DBusMessage): void => {
    if (message.type === MESSAGE_TYPE.methodReturn || message.type === MESSAGE_TYPE.error) {
      const waiter = message.replySerial === undefined ? undefined : replies.get(message.replySerial);
      if (!waiter) return;
      replies.delete(message.replySerial!);
      if (message.type === MESSAGE_TYPE.methodReturn) waiter.resolve(message.body);
      else waiter.reject(new DBusError(message.errorName ?? "org.freedesktop.DBus.Error.Failed", typeof message.body[0] === "string" ? message.body[0] : ""));
    } else if (message.type === MESSAGE_TYPE.signal) {
      for (const listener of signalListeners) listener(message);
    } else if (message.type === MESSAGE_TYPE.methodCall && !(message.flags & FLAG_NO_REPLY) && message.sender) {
      // Nothing is exported here: every incoming call (Peer.Ping included) gets an error, never silence.
      socket.write(
        encodeMessage({
          type: MESSAGE_TYPE.error,
          flags: FLAG_NO_REPLY,
          serial: ++serial,
          errorName: "org.freedesktop.DBus.Error.UnknownMethod",
          replySerial: message.serial,
          destination: message.sender,
          signature: "s",
          body: [`${message.interface ?? ""}.${message.member ?? ""} is not handled here`],
        }),
      );
    }
  };

  socket.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    try {
      for (let length = messageLength(pending); length !== null; length = messageLength(pending)) {
        const message = decodeMessage(pending.subarray(0, length));
        pending = pending.subarray(length);
        dispatch(message);
      }
    } catch (err) {
      socket.destroy(err as Error);
    }
  });
  socket.on("error", (err) => end(err));
  socket.on("close", () => end(null));

  return {
    uniqueName: "",
    call: (call) => {
      if (ended !== undefined) return Promise.reject(ended ?? new Error("D-Bus connection closed"));
      const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
      const id = ++serial;
      replies.set(id, { resolve, reject });
      socket.write(encodeMessage({ type: MESSAGE_TYPE.methodCall, flags: 0, serial: id, ...call }));
      return promise;
    },
    onSignal: (listener) => {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
    onClose: (listener) => {
      if (ended !== undefined) listener(ended);
      else closeListeners.push(listener);
    },
    close: () => {
      socket.end();
      socket.destroy();
      end(null);
    },
  };
};
