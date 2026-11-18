/**
 * META-SRC-09, UX-SET-02: the data credits shown in each app's Settings → About come from the metadata service
 * (`GET /credits`), which alone names where its data comes from. The app keeps the last answer on the device, so the
 * credits still show offline; before any answer it shows a neutral line instead. No ticket: the list is public and
 * the same for everyone.
 */
export type CreditsProduct = "badger" | "parrot";

/** One credited source, as the metadata service sends it. `logo` is a `data:` image; `notice` the text shown beside it. */
export type SourceCredit = {
  id: string;
  name: string;
  url: string;
  text: string;
  licence: string | null;
  licenceUrl: string | null;
  logo: string | null;
  notice: string | null;
};

/** `separator` goes between an entry's name and its text, in the answer's language's typography (the service picks it). */
export type SourceCredits = { product: CreditsProduct; language: string; separator: string; entries: SourceCredit[] };

/** Asks the metadata service for one product's credits in one UI language. */
export type LoadSourceCredits = (product: CreditsProduct, language: string) => Promise<SourceCredits>;

/** Where the last answer is kept: `localStorage` on computers and in browsers, AsyncStorage on phones and TVs. */
export type CreditsStore = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
};

/** What a credits panel needs: how to ask (null when the app cannot, e.g. no service address) and where to keep it. */
export type CreditsSource = { load: LoadSourceCredits | null; store: CreditsStore | null };

type FetchLike = (url: string, init?: { method?: string; credentials?: "omit"; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const text = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

const parseEntry = (value: unknown): SourceCredit | null => {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (!text(entry.id) || !text(entry.name) || !text(entry.url) || !text(entry.text)) return null;
  if (!textOrNull(entry.licence) || !textOrNull(entry.licenceUrl) || !textOrNull(entry.notice)) return null;
  // Only an image address is drawn; anything else is dropped rather than put in an `<img src>`.
  const logo = text(entry.logo) && entry.logo.startsWith("data:image/") ? entry.logo : null;
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    text: entry.text,
    licence: entry.licence,
    licenceUrl: entry.licenceUrl,
    logo,
    notice: entry.notice,
  };
};

/** The answer's shape checked; null when it is not a credits answer. */
export const parseSourceCredits = (value: unknown): SourceCredits | null => {
  if (!value || typeof value !== "object") return null;
  const answer = value as Record<string, unknown>;
  if ((answer.product !== "badger" && answer.product !== "parrot") || !text(answer.language) || !text(answer.separator) || !Array.isArray(answer.entries)) return null;
  const entries = answer.entries.map(parseEntry);
  if (entries.some((entry) => entry === null)) return null;
  return { product: answer.product, language: answer.language, separator: answer.separator, entries: entries as SourceCredit[] };
};

/**
 * `GET <metadataUrl>/credits?product=…&lang=…`, without cookies or any header naming the user. Throws on a refused or
 * malformed answer (the caller keeps what it had).
 */
export const fetchSourceCredits = async (
  metadataUrl: string,
  product: CreditsProduct,
  language: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SourceCredits> => {
  const url = `${metadataUrl.replace(/\/+$/u, "")}/credits?product=${product}&lang=${encodeURIComponent(language)}`;
  const response = await fetchImpl(url, { method: "GET", credentials: "omit", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`credits: metadata service answered ${response.status}`);
  const credits = parseSourceCredits(await response.json());
  if (!credits) throw new Error("credits: unexpected answer");
  return credits;
};

/** A `LoadSourceCredits` for an app that knows its metadata service address (`resolveMetadataUrl`). */
export const metadataCreditsLoader =
  (metadataUrl: () => string, fetchImpl?: FetchLike): LoadSourceCredits =>
  (product, language) =>
    fetchSourceCredits(metadataUrl(), product, language, fetchImpl);

export const creditsStoreKey = (product: CreditsProduct, language: string) => `sf.credits.v1.${product}.${language}`;

/** The page's or window's `localStorage`, for the computer apps and the web players (read when used, not at import). */
export const localStorageCreditsStore: CreditsStore = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
};
