import net from "node:net";

export const tcpProbe = (host: string, port: number, timeoutMs = 1000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });

/**
 * True only when the connection is refused — nothing listens on the port
 * (#25 P4). A timeout or any other error is NOT proof the port is free: a
 * stalled holder with a full accept backlog, or a guardian loop that ran
 * late, both look like a timeout to `tcpProbe`.
 */
export const tcpRefused = (host: string, port: number, timeoutMs = 1000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(false));
    socket.once("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
    socket.setTimeout(timeoutMs, () => done(false));
  });

export const httpHealthProbe = async (baseUrl: string, timeoutMs = 2000): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/runtime/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
};

export const waitForHealth = async (
  baseUrl: string,
  deadlineMs = 15_000,
  intervalMs = 250
): Promise<boolean> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await httpHealthProbe(baseUrl, 2000)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
};
