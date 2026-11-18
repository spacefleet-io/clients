// @vitest-environment jsdom
//
// Tests for IngestUnavailableBanner + the `runtimeError` plumbing in
// `useRuntimeIngestJobs`.
//
// Coverage:
//   - Banner is hidden when runtimeError is null
//   - Banner renders the canonical fallback for engine-down codes
//   - Banner renders custom message for unknown error codes
//   - Banner is dismissable, but re-appears on a different error
//   - Banner re-appears after error→null→error transition
//   - useRuntimeIngestJobs sets runtimeError when IPC returns error envelope
//   - useRuntimeIngestJobs clears runtimeError when health probe succeeds
import React, { useEffect } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import IngestUnavailableBanner from "@/components/IngestUnavailableBanner";
import { useRuntimeIngestJobs } from "@/lib/runtimeIngestJobs";

(globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/runtime-client/jobsV2", () => ({
  createRuntimeJobsV2Stream: vi.fn(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

let container: HTMLDivElement;
let root: Root;

// Dump-on-failure helper. For the banner the decisive facts are: did the
// banner element render, and what does its full text say (the engine-down
// fallback vs the verbatim runtime message). Wrapped in try/catch so a dump
// failure can never mask the real assertion.
const dumpBannerSnapshot = (label: string) => {
  try {
    console.error(`=== [ingest-unavailable-banner:${label}] DOM snapshot ===`);
    const banner = container?.querySelector('[data-testid="ingest-unavailable-banner"]');
    console.error(`banner present=${banner !== null && banner !== undefined}`);
    console.error(`banner textContent=${JSON.stringify(banner?.textContent ?? null)}`);
    const dismiss = container?.querySelector('[data-testid="ingest-unavailable-banner-dismiss"]');
    console.error(`dismiss button present=${dismiss !== null && dismiss !== undefined}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(no container)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Dump the captured hook return — used by the runtimeError-plumbing describe.
const dumpHookSnapshot = (
  label: string,
  captured: { runtimeError?: unknown } | null,
) => {
  try {
    console.error(`=== [ingest-unavailable-banner:${label}] hook snapshot ===`);
    console.error(`captured runtimeError=${JSON.stringify(captured?.runtimeError ?? null, null, 2)}`);
    console.error(
      `window.sf.runtimeJobs present=${Boolean((globalThis as { window?: { sf?: { runtimeJobs?: unknown } } }).window?.sf?.runtimeJobs)}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  console.info(`[ingest-unavailable-banner:setup] mounting root + enabling fake timers`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
});

afterEach(() => {
  console.info(`[ingest-unavailable-banner:teardown] unmounting + restoring real timers/mocks`);
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = (el: React.ReactElement) => {
  act(() => {
    root.render(el);
  });
};

describe("IngestUnavailableBanner", () => {
  it("renders nothing when runtimeError is null", () => {
    render(<IngestUnavailableBanner runtimeError={null} />);
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).toBeNull();
  });

  it("renders the canonical fallback message for engine_v2_disabled", () => {
    render(
      <IngestUnavailableBanner
        runtimeError={{
          errorCode: "engine_v2_disabled",
          message: "ignored",
          status: 503,
        }}
      />,
    );
    const banner = container.querySelector(
      '[data-testid="ingest-unavailable-banner"]',
    );
    if (banner === null) dumpBannerSnapshot("canonical-fallback:no-banner");
    expect(banner).not.toBeNull();
    if (!banner!.textContent?.includes("Ingest unavailable") ||
        !banner!.textContent?.includes("runtime engine v2 not ready") ||
        !banner!.textContent?.includes("dev:core:full"))
      dumpBannerSnapshot("canonical-fallback:copy-mismatch");
    expect(banner!.textContent).toContain("Ingest unavailable");
    expect(banner!.textContent).toContain(
      "runtime engine v2 not ready",
    );
    expect(banner!.textContent).toContain("dev:core:full");
  });

  it.each([
    "engine_v2_not_ready",
    "not_enabled",
    "engine_v2_boot_failed",
    "runtime_jobs_ws_closed",
  ])("treats %s as engine-down and shows the fallback copy", (errorCode) => {
    console.info(`[ingest-unavailable-banner:engine-down-each] rendering errorCode=${errorCode}`);
    render(
      <IngestUnavailableBanner
        runtimeError={{
          errorCode,
          message: "engine-supplied message we want to suppress for engine-down codes",
          status: 503,
        }}
      />,
    );
    const banner = container.querySelector(
      '[data-testid="ingest-unavailable-banner"]',
    );
    if (banner === null) dumpBannerSnapshot(`engine-down-each:${errorCode}:no-banner`);
    expect(banner).not.toBeNull();
    if (!banner!.textContent?.includes("runtime engine v2 not ready") ||
        !banner!.textContent?.includes("dev:core:full") ||
        banner!.textContent?.includes(errorCode))
      dumpBannerSnapshot(`engine-down-each:${errorCode}:copy-mismatch`);
    expect(banner!.textContent).toContain("runtime engine v2 not ready");
    expect(banner!.textContent).toContain("dev:core:full");
    // Engine-down codes show the fallback copy and HIDE the technical
    // detail row (`code:` line is reserved for unknown errors).
    expect(banner!.textContent).not.toContain(errorCode);
  });

  it("renders the runtime-supplied message verbatim for unknown error codes", () => {
    render(
      <IngestUnavailableBanner
        runtimeError={{
          errorCode: "some_other_runtime_error",
          message: "Custom failure detail",
          status: 500,
        }}
      />,
    );
    const banner = container.querySelector(
      '[data-testid="ingest-unavailable-banner"]',
    );
    if (banner === null) dumpBannerSnapshot("unknown-code:no-banner");
    expect(banner).not.toBeNull();
    if (!banner!.textContent?.includes("Custom failure detail") ||
        !banner!.textContent?.includes("some_other_runtime_error") ||
        !banner!.textContent?.includes("HTTP 500"))
      dumpBannerSnapshot("unknown-code:copy-mismatch");
    expect(banner!.textContent).toContain("Custom failure detail");
    expect(banner!.textContent).toContain("some_other_runtime_error");
    expect(banner!.textContent).toContain("HTTP 500");
  });

  it("dismiss button hides banner but persists across re-renders for the same error", () => {
    const err = {
      errorCode: "engine_v2_disabled" as const,
      message: "x",
      status: 503,
    };
    console.info(`[ingest-unavailable-banner:dismiss-persists] rendering with engine_v2_disabled`);
    render(<IngestUnavailableBanner runtimeError={err} />);
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') === null)
      dumpBannerSnapshot("dismiss-persists:initial-missing");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).not.toBeNull();

    console.info(`[ingest-unavailable-banner:dismiss-persists] clicking dismiss`);
    const btn = container.querySelector(
      '[data-testid="ingest-unavailable-banner-dismiss"]',
    ) as HTMLButtonElement;
    act(() => btn.click());

    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') !== null)
      dumpBannerSnapshot("dismiss-persists:still-visible-after-dismiss");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).toBeNull();

    // Re-render with the same error: still hidden.
    console.info(`[ingest-unavailable-banner:dismiss-persists] re-rendering with SAME error (must stay hidden)`);
    render(<IngestUnavailableBanner runtimeError={{ ...err }} />);
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') !== null)
      dumpBannerSnapshot("dismiss-persists:reappeared-on-same-error");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).toBeNull();
  });

  it("re-appears when a different error code occurs after dismissal", () => {
    render(
      <IngestUnavailableBanner
        runtimeError={{
          errorCode: "engine_v2_disabled",
          message: "x",
          status: 503,
        }}
      />,
    );
    console.info(`[ingest-unavailable-banner:reappear-different-code] dismissing engine_v2_disabled`);
    const btn = container.querySelector(
      '[data-testid="ingest-unavailable-banner-dismiss"]',
    ) as HTMLButtonElement;
    act(() => btn.click());
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') !== null)
      dumpBannerSnapshot("reappear-different-code:not-hidden-after-dismiss");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).toBeNull();

    console.info(`[ingest-unavailable-banner:reappear-different-code] rendering DIFFERENT code engine_v2_boot_failed (must reappear)`);
    render(
      <IngestUnavailableBanner
        runtimeError={{
          errorCode: "engine_v2_boot_failed",
          message: "boot threw",
          status: 503,
        }}
      />,
    );
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') === null)
      dumpBannerSnapshot("reappear-different-code:did-not-reappear");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).not.toBeNull();
  });

  it("re-appears after error → null → error transition (health restored then lost)", () => {
    const err = {
      errorCode: "engine_v2_disabled" as const,
      message: "x",
      status: 503,
    };
    console.info(`[ingest-unavailable-banner:reappear-after-null] rendering err, then dismissing`);
    render(<IngestUnavailableBanner runtimeError={err} />);
    const btn = container.querySelector(
      '[data-testid="ingest-unavailable-banner-dismiss"]',
    ) as HTMLButtonElement;
    act(() => btn.click());
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') !== null)
      dumpBannerSnapshot("reappear-after-null:not-hidden-after-dismiss");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).toBeNull();

    console.info(`[ingest-unavailable-banner:reappear-after-null] error->null (health restored)->error (lost again, must reappear)`);
    render(<IngestUnavailableBanner runtimeError={null} />);
    render(<IngestUnavailableBanner runtimeError={{ ...err }} />);
    if (container.querySelector('[data-testid="ingest-unavailable-banner"]') === null)
      dumpBannerSnapshot("reappear-after-null:did-not-reappear");
    expect(
      container.querySelector('[data-testid="ingest-unavailable-banner"]'),
    ).not.toBeNull();
  });
});

describe("useRuntimeIngestJobs runtimeError plumbing", () => {
  it("sets runtimeError from a structured error envelope returned by list()", async () => {
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.sf = {
      runtimeJobs: {
        list: vi.fn(async () => ({
          __runtimeJobsError: true,
          status: 503,
          errorCode: "engine_v2_disabled",
          message: "Set RUNTIME_ENGINE_V2=1",
        })),
        getStreamUrl: vi.fn(),
      },
    };

    console.info(`[ingest-unavailable-banner:hook-error-envelope] mounting probe with list() returning structured error envelope`);
    let captured: ReturnType<typeof useRuntimeIngestJobs> | null = null;
    const Probe = () => {
      captured = useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    if (captured!.runtimeError === null ||
        captured!.runtimeError!.errorCode !== "engine_v2_disabled" ||
        captured!.runtimeError!.status !== 503)
      dumpHookSnapshot("hook-error-envelope:unexpected-runtimeError", captured);
    expect(captured!.runtimeError).not.toBeNull();
    expect(captured!.runtimeError!.errorCode).toBe("engine_v2_disabled");
    expect(captured!.runtimeError!.status).toBe(503);
  });

  it("sets runtimeError when window.sf.runtimeJobs is unavailable", async () => {
    console.info(`[ingest-unavailable-banner:hook-ipc-unavailable] mounting probe with window.sf.runtimeJobs absent`);
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.sf = {};
    let captured: ReturnType<typeof useRuntimeIngestJobs> | null = null;
    const Probe = () => {
      captured = useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    if (captured!.runtimeError === null ||
        captured!.runtimeError!.errorCode !== "runtime_jobs_ipc_unavailable")
      dumpHookSnapshot("hook-ipc-unavailable:unexpected-runtimeError", captured);
    expect(captured!.runtimeError).not.toBeNull();
    expect(captured!.runtimeError!.errorCode).toBe(
      "runtime_jobs_ipc_unavailable",
    );
  });

  it("clears runtimeError when the health probe succeeds", async () => {
    let nextResponse: any = {
      __runtimeJobsError: true,
      status: 503,
      errorCode: "engine_v2_disabled",
      message: "down",
    };
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.sf = {
      runtimeJobs: {
        list: vi.fn(async () => nextResponse),
        getStreamUrl: vi.fn(async () => ({
          url: "ws://x",
          httpBaseUrl: "http://x",
          token: "t",
        })),
      },
    };

    console.info(`[ingest-unavailable-banner:hook-clears-on-recovery] mounting probe; list() initially returns engine_v2_disabled`);
    let captured: ReturnType<typeof useRuntimeIngestJobs> | null = null;
    const Probe = () => {
      captured = useRuntimeIngestJobs();
      return null;
    };
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    if (captured!.runtimeError === null)
      dumpHookSnapshot("hook-clears-on-recovery:expected-error-before-recovery", captured);
    expect(captured!.runtimeError).not.toBeNull();

    // Flip the runtime to healthy and advance the 5s probe interval.
    console.info(`[ingest-unavailable-banner:hook-clears-on-recovery] flipping list() to healthy; advancing 5000ms probe interval (poll: runtimeError should clear to null)`);
    nextResponse = { jobs: [], maxEventId: 0 };
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    console.info(`[ingest-unavailable-banner:hook-clears-on-recovery] post-probe runtimeError=${JSON.stringify(captured!.runtimeError)}`);
    if (captured!.runtimeError !== null)
      dumpHookSnapshot("hook-clears-on-recovery:not-cleared-after-5s-probe", captured);
    expect(captured!.runtimeError).toBeNull();
  });
});
