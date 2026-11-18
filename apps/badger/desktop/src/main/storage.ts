export const bytesToBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const base64ToBytes = (base64: string) => {
  const normalized = base64.trim().replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(normalized, "base64"));
};
