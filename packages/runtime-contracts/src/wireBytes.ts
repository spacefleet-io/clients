/**
 * RT-CMD-05: bytes inside a runtime command's payload or result cross the JSON wire as `{ __sfWireBytes: base64 }`.
 * Plain JSON turns a Uint8Array into `{"0":…,"1":…}` (a Buffer into `{type:"Buffer",data:[…]}`): the other side then
 * holds an object with no `.buffer`, and every byte consumer (encrypting a library export for a key rotation) fails.
 * Both walks return the value they were given, untouched, when it holds no bytes (no copy of large results).
 */

const TAG = "__sfWireBytes";

type WireBytes = { [TAG]: string };

const toBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  if (typeof Buffer !== "undefined") {
    const buffer = Buffer.from(value, "base64");
    // A plain Uint8Array (not a Buffer) so Electron IPC and Web Crypto see the same type as the sender had.
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isWireBytes = (value: Record<string, unknown>): value is WireBytes => {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === TAG && typeof value[TAG] === "string";
};

/** Rebuilds `value` with every byte view (Uint8Array, Buffer, other views, ArrayBuffer) tagged; same reference if none. */
export const encodeWireBytes = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) {
    return { [TAG]: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) } as T;
  }
  if (value instanceof ArrayBuffer) return { [TAG]: toBase64(new Uint8Array(value)) } as T;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = encodeWireBytes(value[i]);
      if (next !== value[i] && !out) out = value.slice(0, i);
      if (out) out.push(next);
    }
    return (out ?? value) as T;
  }
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | null = null;
  const entries = Object.keys(value);
  for (let i = 0; i < entries.length; i += 1) {
    const key = entries[i]!;
    const current = value[key];
    const next = encodeWireBytes(current);
    if (next !== current && !out) {
      out = {};
      for (let j = 0; j < i; j += 1) out[entries[j]!] = value[entries[j]!];
    }
    if (out) out[key] = next;
  }
  return (out ?? value) as T;
};

/** Turns every `{ __sfWireBytes }` back into a Uint8Array; same reference if none. */
export const decodeWireBytes = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = decodeWireBytes(value[i]);
      if (next !== value[i] && !out) out = value.slice(0, i);
      if (out) out.push(next);
    }
    return (out ?? value) as T;
  }
  if (!isPlainObject(value)) return value;
  if (isWireBytes(value)) return fromBase64(value[TAG]) as T;
  let out: Record<string, unknown> | null = null;
  const entries = Object.keys(value);
  for (let i = 0; i < entries.length; i += 1) {
    const key = entries[i]!;
    const current = value[key];
    const next = decodeWireBytes(current);
    if (next !== current && !out) {
      out = {};
      for (let j = 0; j < i; j += 1) out[entries[j]!] = value[entries[j]!];
    }
    if (out) out[key] = next;
  }
  return (out ?? value) as T;
};
