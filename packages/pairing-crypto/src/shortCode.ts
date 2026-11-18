import { normalizeSpaceAppId, type SpaceAppId } from "@space/shared/appScope";

/** Crockford base32 without I, L, O, U. 32 symbols, so a random byte maps without bias (byte & 31). */
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 8;

const ALIASES: Record<string, string> = { O: "0", I: "1", L: "1" };

/**
 * Canonical form of a typed code: upper-case, dashes/spaces dropped, Crockford look-alikes
 * (O→0, I/L→1) folded. Returns null when the result is not exactly 8 alphabet characters.
 */
export const normalizeShortCode = (input: string): string | null => {
  let out = "";
  for (const raw of input.toUpperCase()) {
    if (raw === "-" || raw === " " || raw === "\u2013" || raw === "\u2014") continue;
    const ch = ALIASES[raw] ?? raw;
    if (!SHORT_CODE_ALPHABET.includes(ch)) return null;
    out += ch;
  }
  return out.length === SHORT_CODE_LENGTH ? out : null;
};

/** "ABCDEFGH" → "ABCD-EFGH". Input must already be normalised. */
export const formatShortCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Maps CSPRNG bytes (at least 8) to a canonical short code. */
export const shortCodeFromRandomBytes = (bytes: Uint8Array): string => {
  if (bytes.length < SHORT_CODE_LENGTH) throw new Error("need at least 8 random bytes");
  let out = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) out += SHORT_CODE_ALPHABET[bytes[i]! & 31]!;
  return out;
};

/**
 * ACCT-PAIR-06: the QR code of a new device is a web link on the website naming the app that asks,
 * `<website>/pair/<app>?code=ABCD-EFGH`. The phone's camera opens it in that app (Android App Links,
 * iOS Universal Links, each app claiming only its own `/pair/<app>` path) and, when that app is not
 * installed, in the browser, on the website's page for that app.
 */
export const buildPairLink = (webBaseUrl: string, app: SpaceAppId, code: string): string =>
  `${webBaseUrl.trim().replace(/\/+$/u, "")}/pair/${app}?code=${formatShortCode(code)}`;

// scheme://host[:port]/[<lang>/]pair/<app>?query; the website's own page may carry a language segment.
const PAIR_LINK = /^https?:\/\/[^/?#\s]+\/(?:[a-z]{2}\/)?pair\/([a-z]+)\/?\?([^#\s]*)/iu;

/**
 * Reads a pairing link back (ACCT-PAIR-06): the asking app and the canonical short code, or null when
 * the text is not a link to `/pair/<known app>` with a valid `code`. Any host: each environment's
 * website builds its own links. Extra query parameters are ignored.
 */
export const parsePairLink = (text: string): { app: SpaceAppId; code: string } | null => {
  const match = PAIR_LINK.exec(text.trim());
  if (!match) return null;
  const app = normalizeSpaceAppId(match[1]);
  if (!app) return null;
  for (const part of match[2]!.split("&")) {
    const [key, value] = part.split("=");
    if (key !== "code" || value === undefined) continue;
    try {
      const code = normalizeShortCode(decodeURIComponent(value));
      return code ? { app, code } : null;
    } catch {
      return null;
    }
  }
  return null;
};

// spacebadger://pair?code=ABCD-EFGH: the QR of desktops released before ACCT-PAIR-06.
const LEGACY_PAIR_LINK = /^spacebadger:\/\/pair\/?\?([^#\s]*)/iu;

/**
 * Reads the QR of a desktop released before ACCT-PAIR-06, `spacebadger://pair?code=ABCD-EFGH`, back to
 * its canonical short code, or null. Kept only while such desktops are still supported (ACCT-PAIR-06):
 * remove it, with Badger mobile's `spacebadger://pair` claim, once every desktop version that draws it is
 * below the minimum supported version (REL-CD-08).
 */
export const parseLegacyPairLink = (text: string): string | null => {
  const match = LEGACY_PAIR_LINK.exec(text.trim());
  if (!match) return null;
  for (const part of match[1]!.split("&")) {
    const [key, value] = part.split("=");
    if (key !== "code" || value === undefined) continue;
    try {
      return normalizeShortCode(decodeURIComponent(value));
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Reads a scanned QR text (or a typed code) and returns the canonical short code, or null if it
 * is not a pairing code: a pairing link (ACCT-PAIR-06), the older `spacebadger://pair` link
 * (parseLegacyPairLink), or a bare code with or without the dash. Any other link is refused rather
 * than read as a code.
 */
export const parsePairQrPayload = (payload: string): string | null => {
  const text = payload.trim();
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) return parsePairLink(text)?.code ?? parseLegacyPairLink(text);
  return normalizeShortCode(text);
};
