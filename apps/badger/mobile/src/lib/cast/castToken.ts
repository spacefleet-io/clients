/**
 * The one-time address a cast target is given (UX-TV-03: "behind a one-time address"). The phone serves the decrypted
 * film on the local Wi-Fi to whoever knows the URL, so the URL carries an unguessable token: 192 random bits, base64url
 * (32 characters), minted per cast and valid until that cast ends. The native cast server (`CastServer.start`) only
 * answers paths under `/cast/<token>/`; stopping the cast stops the server, so the address is dead afterwards and a
 * later cast gets a different one.
 *
 * Pure but for the random source, which is injected (`crypto.getRandomValues`, polyfilled by react-native-get-random-values).
 */

export const CAST_TOKEN_BYTES = 24;

export type RandomSource = (bytes: Uint8Array) => Uint8Array;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const toBase64Url = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64URL[(chunk >> 18) & 63]! + BASE64URL[(chunk >> 12) & 63]! + BASE64URL[(chunk >> 6) & 63]! + BASE64URL[chunk & 63]!;
  }
  return out;
};

const globalRandom: RandomSource = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** A fresh token. 24 bytes divide evenly into base64 groups, so the result has no padding and no `+` or `/`. */
export const generateCastToken = (random: RandomSource = globalRandom): string => {
  const bytes = random(new Uint8Array(CAST_TOKEN_BYTES));
  if (bytes.length !== CAST_TOKEN_BYTES) throw new Error(`cast token: random source returned ${bytes.length} bytes`);
  // An all-zero answer means the source did nothing (a broken polyfill); a token like that would be guessable.
  if (bytes.every((byte) => byte === 0)) throw new Error("cast token: random source returned only zeros");
  return toBase64Url(bytes);
};

export const isCastToken = (value: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(value);

/** Path prefix every cast URL lives under; the native server and this file agree on it. */
export const castPathPrefix = (token: string): string => {
  if (!isCastToken(token)) throw new Error("cast token: malformed");
  return `/cast/${token}`;
};

/**
 * Holds the address of the cast in progress. A new cast revokes the previous token (its server is stopped by the caller
 * first), `revoke` ends the current one, and a token is never issued twice.
 */
export class CastTokenIssuer {
  private current: string | null = null;
  private readonly issued = new Set<string>();

  constructor(private readonly random: RandomSource = globalRandom) {}

  issue(): string {
    const token = generateCastToken(this.random);
    // 2^-192 per pair: a repeat means a broken random source, not bad luck.
    if (this.issued.has(token)) throw new Error("cast token: random source repeated a token");
    this.issued.add(token);
    this.current = token;
    return token;
  }

  /** True only for the token of the cast in progress. */
  isValid(token: string): boolean {
    return this.current !== null && token === this.current;
  }

  revoke(): void {
    this.current = null;
  }
}
