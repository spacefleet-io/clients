import { isSessionRejected } from "@space/shared/api";

export const shouldLogoutAfterAuthProbe = async (input: {
  probe: () => Promise<unknown>;
  attempts?: number;
  delayMs?: number;
}) => {
  const attempts = Math.max(1, Math.floor(input.attempts ?? 2));
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? 300));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await input.probe();
      return false;
    } catch (error) {
      if (!isSessionRejected(error)) {
        return false;
      }
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return true;
};
