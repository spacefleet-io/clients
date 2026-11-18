import type { ProcessLayer } from "@space/desktop-platform-contract";

/**
 * Graceful stop on Linux is the signal pair: the runtime handles SIGTERM (the
 * guardian's request) and SIGINT (Ctrl+C), the guardian sends SIGTERM.
 */
export const linuxGracefulStop: ProcessLayer["gracefulStop"] = {
  install: (onRequest) => {
    const onTerm = () => onRequest("SIGTERM");
    const onInt = () => onRequest("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    return () => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    };
  },
  request: (pid) => {
    try {
      return process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  },
};
