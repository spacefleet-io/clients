/**
 * Parent side of the OCR child: resolves how to launch `cli.ts`, spawns it at
 * low CPU priority, relays its JSON lines and settles with its summary.
 */
import { spawn } from "node:child_process";
import { constants as osConstants, setPriority } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { SubtitleOcrChildMessage, SubtitleOcrLog } from "./types";

export type SubtitleOcrLauncher = { command: string; args: string[]; env: Record<string, string> };

export type SubtitleOcrProcessSummary = {
  codec: string;
  pictures: number;
  cues: number;
  empty: number;
  failures: number;
  ms: number;
};

/**
 * Packaged build: `SF_SUBTITLE_OCR_DIR` holds `subtitle-ocr.js` (the bundled
 * CLI) beside a `node_modules/` with tesseract.js, tesseract.js-core and their
 * runtime deps; the runtime is a `bun build --compile` binary, so it relaunches
 * itself as plain bun (`BUN_BE_BUN=1`) to run that script. Dev: run `cli.ts`
 * from source with the current bun (or `bun` on PATH when hosted by node, e.g. vitest).
 */
export const resolveSubtitleOcrLauncher = (env: NodeJS.ProcessEnv = process.env): SubtitleOcrLauncher => {
  const packagedDir = env.SF_SUBTITLE_OCR_DIR?.trim();
  if (packagedDir) {
    return { command: process.execPath, args: [join(packagedDir, "subtitle-ocr.js")], env: { BUN_BE_BUN: "1" } };
  }
  return {
    command: process.versions.bun ? process.execPath : "bun",
    args: [fileURLToPath(new URL("./cli.ts", import.meta.url))],
    env: {},
  };
};

export type RunSubtitleOcrProcessOptions = {
  inputPath: string;
  outPath: string;
  tesseractLang: string;
  langDir: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  log: SubtitleOcrLog;
  /** Defaults to resolveSubtitleOcrLauncher(). */
  launcher?: SubtitleOcrLauncher;
};

const STDERR_TAIL_CHARS = 4000;

export const runSubtitleOcrProcess = (options: RunSubtitleOcrProcessOptions): Promise<SubtitleOcrProcessSummary> => {
  const { promise, resolve, reject } = Promise.withResolvers<SubtitleOcrProcessSummary>();
  const { inputPath, outPath, tesseractLang, langDir, signal, log } = options;
  if (signal?.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new Error("subtitle OCR aborted"));
    return promise;
  }
  const launcher = options.launcher ?? resolveSubtitleOcrLauncher();
  const args = [
    ...launcher.args,
    "--input",
    inputPath,
    "--out",
    outPath,
    "--lang",
    tesseractLang,
    "--lang-dir",
    langDir,
    ...(options.ffprobePath ? ["--ffprobe", options.ffprobePath] : []),
  ];
  log("[subtitle-ocr] child.spawn", { command: launcher.command, args, tesseractLang, inputPath, outPath });
  const child = spawn(launcher.command, args, {
    env: { ...process.env, ...launcher.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let result: SubtitleOcrProcessSummary | null = null;
  let childError: string | null = null;
  let stderrTail = "";
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    log("[subtitle-ocr] child.abort", { pid: child.pid, inputPath });
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, osConstants.priority.PRIORITY_LOW);
      log("[subtitle-ocr] child.priority", { pid: child.pid, priority: "low" });
    } catch (error) {
      log("[subtitle-ocr] child.priority_failed", {
        pid: child.pid,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // An abort fired from the child.spawn log callback, before the listener existed, must still kill the child.
  if (signal?.aborted && !aborted) onAbort();

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: SubtitleOcrChildMessage;
    try {
      message = JSON.parse(line) as SubtitleOcrChildMessage;
    } catch {
      log("[subtitle-ocr] child.stdout", { line });
      return;
    }
    switch (message.type) {
      case "progress":
        log("[subtitle-ocr] progress", { inputPath, done: message.done, total: message.total });
        break;
      case "log":
        log(message.event, message.payload);
        break;
      case "result": {
        const { type: _type, ...summary } = message;
        result = summary;
        break;
      }
      case "error":
        childError = message.message;
        break;
    }
  });

  child.on("error", (error) => {
    signal?.removeEventListener("abort", onAbort);
    reject(new Error(`subtitle OCR child failed to start (${launcher.command}): ${error.message}`));
  });
  child.on("close", (code, killedBy) => {
    signal?.removeEventListener("abort", onAbort);
    if (aborted) {
      reject(signal?.reason instanceof Error ? signal.reason : new Error("subtitle OCR aborted"));
      return;
    }
    if (code === 0 && result) {
      log("[subtitle-ocr] child.done", { inputPath, tesseractLang, ...result });
      resolve(result);
      return;
    }
    const tail = stderrTail.trim();
    const message = `subtitle OCR child exited ${code ?? killedBy}: ${childError ?? "no result"}${tail ? `\nstderr: ${tail}` : ""}`;
    log("[subtitle-ocr] child.failed", { inputPath, code, signal: killedBy, error: childError, stderrTail: tail });
    reject(new Error(message));
  });
  return promise;
};
