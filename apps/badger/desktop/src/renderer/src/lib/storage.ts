type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function readJson<T extends JsonValue>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: JsonValue) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function removeItem(key: string) {
  localStorage.removeItem(key);
}

export const bytesToBase64 = (bytes: Uint8Array) => {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

export const base64ToBytes = (base64: string) => {
  const normalized = base64.trim().replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** A key without its words (received from another device by pairing), in groups of 4 characters. */
export function formatKeyForDisplay(key: string) {
  const normalized = key.replace(/\s+/g, "");
  return normalized.match(/.{1,4}/g)?.join(" ") ?? normalized;
}
