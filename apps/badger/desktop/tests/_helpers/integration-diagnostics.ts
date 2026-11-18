// Shared diagnostic capture for Electron integration tests.
//
// Usage:
//   const diag = await attachRendererDiagnostics(page, { app });
//   try { ... assertions ... }
//   catch (err) { await diag.dumpToConsole({ label: "startup-smoke" }); throw err; }
//
// Captures, on test failure, into stdout via the Playwright reporter:
//   - Renderer console errors / warnings
//   - Uncaught renderer pageerror events
//   - Failed renderer network requests (with URL)
//   - HTTP responses with status >= 400 (with URL)
//   - Main-process native dialog calls (showErrorBox, showMessageBox, etc.) —
//     these live in the main process, not in the renderer
//   - Main-process stderr (errors that crash the app or are logged before
//     a window even opens)
//
// Call attachRendererDiagnostics with `{ app }` to enable the main-process
// captures. The `page`-only form still works for backward compatibility but
// will miss native popups and main-process errors.

import type { ElectronApplication, Page } from "playwright";

export type RendererDiagnostics = {
  errors: string[];
  warnings: string[];
  pageErrors: string[];
  /** Network requests that failed at the transport layer (DNS, refused, aborted). */
  failedRequests: string[];
  /** HTTP responses with status >= 400, formatted as `STATUS METHOD URL`. */
  errorResponses: string[];
  /** Calls to dialog.showErrorBox / showMessageBox / showMessageBoxSync from main. */
  mainDialogs: string[];
  /** Main-process stderr lines (often Electron / native module errors). */
  mainStderr: string[];
  /**
   * Print all captured diagnostics to stdout under a clear header.
   * No-op when buffers are empty. Async because main-process dialog buffer
   * lives inside the Electron process and needs an `app.evaluate` round-trip
   * to retrieve.
   */
  dumpToConsole(opts?: { label?: string }): Promise<void>;
};

const formatList = (header: string, items: string[]): string | null => {
  if (items.length === 0) return null;
  const body = items.map((line, idx) => `  [${idx}] ${line}`).join("\n");
  return `${header} (${items.length}):\n${body}`;
};

export async function attachRendererDiagnostics(
  page: Page,
  opts: { app?: ElectronApplication } = {}
): Promise<RendererDiagnostics> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const errorResponses: string[] = [];
  const mainStderr: string[] = [];

  page.on("console", (message) => {
    const type = message.type();
    if (type === "error") errors.push(message.text());
    else if (type === "warning") warnings.push(message.text());
  });

  page.on("pageerror", (error) => {
    const stack = error.stack ?? error.message ?? String(error);
    pageErrors.push(stack);
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure();
    failedRequests.push(`${request.method()} ${request.url()} — ${failure?.errorText ?? "unknown"}`);
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      errorResponses.push(`${status} ${response.request().method()} ${response.url()}`);
    }
  });

  if (opts.app) {
    // Wrap main-process native dialog calls so popups push into a global
    // buffer we can read at dump time. Without this, native dialogs vanish
    // (renderer page.on hooks never see them).
    await opts.app
      .evaluate(({ dialog }) => {
        const target = globalThis as typeof globalThis & {
          __sfDiagDialogs?: string[];
          __sfDiagDialogsInstalled?: boolean;
        };
        if (target.__sfDiagDialogsInstalled) return;
        target.__sfDiagDialogsInstalled = true;
        target.__sfDiagDialogs = [];
        const summarize = (name: string, args: unknown[]): string => {
          const parts = args.map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a).slice(0, 300);
            } catch {
              return String(a);
            }
          });
          return `${name}: ${parts.join(" | ")}`;
        };
        const wrap = <K extends keyof typeof dialog>(name: K) => {
          const original = dialog[name] as unknown as (...args: unknown[]) => unknown;
          if (typeof original !== "function") return;
          (dialog[name] as unknown) = (...args: unknown[]) => {
            target.__sfDiagDialogs?.push(summarize(name, args));
            return original.apply(dialog, args);
          };
        };
        wrap("showErrorBox");
        wrap("showMessageBox");
        wrap("showMessageBoxSync");
      })
      .catch(() => undefined);

    // Capture main-process stderr — Electron and native modules write here
    // when they crash before a window opens.
    const proc = opts.app.process();
    if (proc?.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) mainStderr.push(trimmed);
        }
      });
    }
  }

  const dumpToConsole = async ({ label }: { label?: string } = {}) => {
    const mainDialogs: string[] = [];
    if (opts.app) {
      try {
        const captured = await opts.app.evaluate(() => {
          const target = globalThis as typeof globalThis & { __sfDiagDialogs?: string[] };
          return target.__sfDiagDialogs ?? [];
        });
        mainDialogs.push(...captured);
      } catch {
        // App may already be quit/closed — fall through with no dialogs.
      }
    }

    const blocks = [
      formatList("main-process dialog popups", mainDialogs),
      formatList("main-process stderr", mainStderr),
      formatList("renderer pageerrors", pageErrors),
      formatList("renderer console errors", errors),
      formatList("renderer failed network requests", failedRequests),
      formatList("renderer HTTP error responses", errorResponses),
      formatList("renderer console warnings", warnings),
    ].filter((b): b is string => b !== null);

    if (blocks.length === 0) return;
    const header = `=== renderer diagnostics${label ? ` (${label})` : ""} ===`;
    console.error(`${header}\n${blocks.join("\n")}\n${"=".repeat(header.length)}`);
  };

  // mainDialogs in the returned object stays empty — it's filled lazily
  // inside dumpToConsole. Exposed for type-completeness.
  const mainDialogs: string[] = [];

  return {
    errors,
    warnings,
    pageErrors,
    failedRequests,
    errorResponses,
    mainDialogs,
    mainStderr,
    dumpToConsole,
  };
}

/**
 * Wrap an integration assertion block so any thrown error is rethrown with
 * the captured diagnostic buffer + a renderer-state snapshot appended to the
 * message. Use around the specific `expect.poll(...)` or `await expect(...)`
 * you want richer context on — invaluable for "click triggers async work,
 * navigation never happens" timeouts where the console is silent but the DOM
 * tells the story.
 *
 * Example:
 *   await withDiagnostics(diag, async () => {
 *     await expect.poll(...).toMatchObject(...);
 *   }, { page });
 */
export const withDiagnostics = async <T>(
  diagnostics: RendererDiagnostics,
  fn: () => Promise<T>,
  options: { page?: Page } = {}
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const lines: string[] = [];
    for (const e of diagnostics.pageErrors) lines.push(`[pageerror] ${e}`);
    for (const e of diagnostics.errors) lines.push(`[console:error] ${e}`);
    for (const r of diagnostics.failedRequests) lines.push(`[requestfailed] ${r}`);
    for (const r of diagnostics.errorResponses) lines.push(`[response] ${r}`);
    for (const r of diagnostics.mainStderr) lines.push(`[main:stderr] ${r}`);
    for (const w of diagnostics.warnings) lines.push(`[console:warning] ${w}`);
    const buffer = lines.join("\n");
    const sections: string[] = [];
    sections.push(buffer ? `--- renderer diagnostics ---\n${buffer}` : "--- renderer diagnostics: (empty) ---");
    if (options.page) {
      try {
        const snapshot = await options.page.evaluate(() => {
          const pickText = (selector: string) =>
            Array.from(document.querySelectorAll(selector))
              .slice(0, 5)
              .map((node) => (node.textContent ?? "").trim())
              .filter(Boolean);
          const bodyClone = document.body.cloneNode(true) as HTMLElement;
          bodyClone
            .querySelectorAll("style, script, svg, defs, link, noscript")
            .forEach((node) => node.remove());
          const visibleText = (bodyClone.textContent ?? "").replace(/\s+/g, " ").trim();
          return {
            href: window.location.href,
            pathname: window.location.pathname,
            title: document.title,
            visibleErrorText: pickText('[role="alert"], [data-state="error"], .error, [aria-live="assertive"]'),
            buttons: Array.from(document.querySelectorAll("button"))
              .slice(0, 20)
              .map((node) => ({
                text: (node.textContent ?? "").trim().slice(0, 80),
                disabled: (node as HTMLButtonElement).disabled,
              })),
            inputs: Array.from(document.querySelectorAll('input[type="checkbox"]'))
              .slice(0, 10)
              .map((node) => ({
                name: (node as HTMLInputElement).name || (node as HTMLInputElement).id,
                checked: (node as HTMLInputElement).checked,
              })),
            visibleText: visibleText.slice(0, 1500),
          };
        });
        sections.push(`--- page snapshot ---\n${JSON.stringify(snapshot, null, 2)}`);
      } catch (snapshotError) {
        sections.push(`--- page snapshot failed: ${String(snapshotError)} ---`);
      }
    }
    const trailer = `\n${sections.join("\n")}`;
    if (error instanceof Error) {
      error.message = `${error.message}${trailer}`;
      throw error;
    }
    throw new Error(`${String(error)}${trailer}`);
  }
};
