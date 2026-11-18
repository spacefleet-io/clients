/** Source of cryptographically secure random bytes, injected so every runtime can supply its own. */
export type GetRandomBytes = (length: number) => Uint8Array;

/** Default source: `globalThis.crypto.getRandomValues` (Hermes with a polyfill, Electron, Node >= 19, Bun). */
export const defaultGetRandomBytes: GetRandomBytes = (length) => {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(array: T) => T } }).crypto;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("privacy-pass: no globalThis.crypto.getRandomValues; pass getRandomBytes explicitly");
  }
  return webCrypto.getRandomValues(new Uint8Array(length));
};
