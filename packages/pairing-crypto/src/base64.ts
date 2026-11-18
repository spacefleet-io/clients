const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const encodeWith = (bytes: Uint8Array, alphabet: string, pad: boolean): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? "=" : "");
  }
  return out;
};

/** Standard base64 (RFC 4648 §4, padded). Pure TS: works in Bun, Node, browsers and React Native. */
export const bytesToBase64 = (bytes: Uint8Array): string => encodeWith(bytes, STD, true);

/** URL-safe base64 without padding (RFC 4648 §5). */
export const bytesToBase64Url = (bytes: Uint8Array): string => encodeWith(bytes, URL_SAFE, false);

/** Decodes standard or URL-safe base64, padded or not. Throws on any other character. */
export const base64ToBytes = (value: string): Uint8Array => {
  const clean = value.replace(/=+$/u, "");
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!;
    let v = STD.indexOf(ch);
    if (v < 0) v = URL_SAFE.indexOf(ch);
    if (v < 0) throw new Error("invalid base64 character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
};
