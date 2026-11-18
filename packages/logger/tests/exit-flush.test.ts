import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOGGER_SRC = resolve(import.meta.dirname, "../src/index.ts");

/**
 * A child that logs one pretty line and dies at once, with no exit handler to flush anything: the line is only
 * there when the logger wrote it before `warn` returned. That is what a service's last line needs, because the
 * shutdown routine logs `shutdown_forced` and calls process.exit(1) right after (REL-CD-06).
 */
const runChild = async (dir: string): Promise<{ out: string; signal: NodeJS.Signals | null }> => {
  const script = join(dir, "child.ts");
  writeFileSync(
    script,
    [
      `import { createLogger } from ${JSON.stringify(LOGGER_SRC)};`,
      `const logger = createLogger({ service: "exit-flush", pretty: true });`,
      `logger.warn({ event: "shutdown_forced" }, "last_line_before_exit");`,
      `process.kill(process.pid, "SIGKILL");`,
    ].join("\n"),
  );
  const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const { promise: closed, resolve: done } = Promise.withResolvers<NodeJS.Signals | null>();
  child.once("close", (_code, sig) => done(sig));
  const signal = await closed;
  return { out, signal };
};

describe("@space/logger pretty output at exit @req REL-LOG-02[migration-worker]", () => {
  it("a pretty line is written before the call returns, so a process that ends right after keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-logger-exit-"));
    const runs = await Promise.all(Array.from({ length: 10 }, () => runChild(dir)));
    for (const [i, run] of runs.entries()) {
      console.log(`[logger:exit-flush] run ${i}: signal=${run.signal} output=${JSON.stringify(run.out)}`);
      expect(run.signal).toBe("SIGKILL");
      expect(run.out).toContain("last_line_before_exit");
    }
  });
});
