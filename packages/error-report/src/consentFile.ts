import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The user's answer: `on`, `off`, or `undecided` before they were ever asked. */
export type ReportDecision = "on" | "off" | "undecided";

export interface ConsentFile {
  read(): ReportDecision;
  write(decision: "on" | "off"): void;
}

interface Stored {
  version: 1;
  decision: "on" | "off";
}

/**
 * Keeps the choice in a small file the main process can read before any window
 * exists. A missing, unreadable or unrecognised file is "undecided", which
 * never reports.
 */
export function createConsentFile(path: string): ConsentFile {
  return {
    read() {
      try {
        if (!existsSync(path)) return "undecided";
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
        return parsed.version === 1 && (parsed.decision === "on" || parsed.decision === "off") ? parsed.decision : "undecided";
      } catch {
        return "undecided";
      }
    },
    write(decision) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ version: 1, decision } satisfies Stored)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}
