import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyLibraryOpenFallback,
  clearStaleLibraryErrorAfterSnapshot,
  createInFlightOnce,
  getLibraryLoadErrorMessage,
  isDecryptFailureMessage,
  isOfflineModeFallbackMessage,
  isReconnectProbeStillDown,
  isRemoteUnreachableError,
  isSyncUnavailableFallbackMessage,
  OFFLINE_MODE_FALLBACK_MESSAGE,
  RECONNECT_PROBE_INTERVAL_MS,
  RECONNECT_PROBE_TIMEOUT_MESSAGE,
  RECONNECT_PROBE_TIMEOUT_MS,
  shouldConfirmBackendOutage,
  shouldPollForBackendRecovery,
  SYNC_UNAVAILABLE_BLOCKING_MESSAGE,
  SYNC_UNAVAILABLE_FALLBACK_MESSAGE,
  type LibraryOpenFallbackKind,
} from "../src/renderer/src/lib/libraryContext";

// Dump-on-failure: surface the inputs + computed classification so a failing
// error-normalization assertion is diagnosable offline.
const dumpLibraryErrorSnapshot = (label: string, value: unknown) => {
  try {
    console.error(`=== [library-context-errors:${label}] snapshot ===`);
    console.error(`computed:\n${JSON.stringify(value, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library context error normalization", () => {
  it("normalizes string and Error sync failures the same way", () => {
    const results = {
      fromError: getLibraryLoadErrorMessage(new Error("SYNC_UNAVAILABLE")),
      fromString: getLibraryLoadErrorMessage("SYNC_UNAVAILABLE"),
    };
    console.info(`[library-context-errors:normalize] results=${JSON.stringify(results)}`);
    try {
      expect(getLibraryLoadErrorMessage(new Error("SYNC_UNAVAILABLE"))).toBe("SYNC_UNAVAILABLE");
      expect(getLibraryLoadErrorMessage("SYNC_UNAVAILABLE")).toBe("SYNC_UNAVAILABLE");
    } catch (err) {
      dumpLibraryErrorSnapshot("normalize", results);
      throw err;
    }
  });

  it("@bugfix @regression-proof recognizes decrypt failures regardless of casing or payload shape", () => {
    const results = {
      DECRYPT_FAILED: isDecryptFailureMessage(new Error("DECRYPT_FAILED")),
      decrypt_failed_err: isDecryptFailureMessage(new Error("decrypt_failed")),
      decrypt_failed_str: isDecryptFailureMessage("decrypt_failed"),
      MANIFEST_DECRYPT_FAILED: isDecryptFailureMessage("MANIFEST_DECRYPT_FAILED"),
      SYNC_UNAVAILABLE: isDecryptFailureMessage(new Error("SYNC_UNAVAILABLE")),
    };
    console.info(`[library-context-errors:decrypt-classify] results=${JSON.stringify(results)}`);
    try {
      expect(isDecryptFailureMessage(new Error("DECRYPT_FAILED"))).toBe(true);
      expect(isDecryptFailureMessage(new Error("decrypt_failed"))).toBe(true);
      expect(isDecryptFailureMessage("decrypt_failed")).toBe(true);
      expect(isDecryptFailureMessage("MANIFEST_DECRYPT_FAILED")).toBe(true);
      expect(isDecryptFailureMessage(new Error("SYNC_UNAVAILABLE"))).toBe(false);
    } catch (err) {
      dumpLibraryErrorSnapshot("decrypt-classify", results);
      throw err;
    }
  });

  it("classifies local fallback sync warnings as non-fatal", () => {
    const results = {
      fallbackMsg: isSyncUnavailableFallbackMessage(SYNC_UNAVAILABLE_FALLBACK_MESSAGE),
      genericLoadFail: isSyncUnavailableFallbackMessage("Could not load your library database."),
      nullInput: isSyncUnavailableFallbackMessage(null),
    };
    console.info(`[library-context-errors:fallback-classify] results=${JSON.stringify(results)}`);
    try {
      expect(isSyncUnavailableFallbackMessage(SYNC_UNAVAILABLE_FALLBACK_MESSAGE)).toBe(true);
      expect(isSyncUnavailableFallbackMessage("Could not load your library database.")).toBe(false);
      expect(isSyncUnavailableFallbackMessage(null)).toBe(false);
    } catch (err) {
      dumpLibraryErrorSnapshot("fallback-classify", results);
      throw err;
    }
  });

  it("@bugfix @regression-proof clears stale blocking sync errors after a successful snapshot", () => {
    const results = {
      blocking: clearStaleLibraryErrorAfterSnapshot(SYNC_UNAVAILABLE_BLOCKING_MESSAGE),
      fallback: clearStaleLibraryErrorAfterSnapshot(SYNC_UNAVAILABLE_FALLBACK_MESSAGE),
      generic: clearStaleLibraryErrorAfterSnapshot("Could not load your library database."),
    };
    console.info(`[library-context-errors:clear-stale] results=${JSON.stringify(results)}`);
    try {
      expect(clearStaleLibraryErrorAfterSnapshot(SYNC_UNAVAILABLE_BLOCKING_MESSAGE)).toBeNull();
      expect(clearStaleLibraryErrorAfterSnapshot(SYNC_UNAVAILABLE_FALLBACK_MESSAGE)).toBe(
        SYNC_UNAVAILABLE_FALLBACK_MESSAGE
      );
      expect(clearStaleLibraryErrorAfterSnapshot("Could not load your library database.")).toBe(
        "Could not load your library database."
      );
    } catch (err) {
      dumpLibraryErrorSnapshot("clear-stale", results);
      throw err;
    }
  });

  it("@bugfix @regression-proof deduplicates concurrent library loads", async () => {
    console.info(`[library-context-errors:dedup] firing two concurrent runOnce() calls`);
    let calls = 0;
    const firstLoad = Promise.withResolvers<string>();
    const runOnce = createInFlightOnce(
      () => {
        calls += 1;
        console.info(`[library-context-errors:dedup] underlying factory invoked, calls=${calls}`);
        if (calls === 1) {
          return firstLoad.promise;
        }
        return Promise.resolve("second");
      }
    );

    const first = runOnce();
    const second = runOnce();

    console.info(
      `[library-context-errors:dedup] after two concurrent calls: calls=${calls} sameRef=${first === second}`,
    );
    try {
      expect(calls).toBe(1);
      expect(first).toBe(second);
    } catch (err) {
      dumpLibraryErrorSnapshot("dedup-concurrent", { calls, sameRef: first === second });
      throw err;
    }

    firstLoad.resolve("ok");

    const firstValue = await first;
    const secondRunValue = await runOnce();
    console.info(
      `[library-context-errors:dedup] resolved firstValue=${JSON.stringify(firstValue)} secondRunValue=${JSON.stringify(secondRunValue)} finalCalls=${calls}`,
    );
    try {
      expect(firstValue).toBe("ok");
      expect(secondRunValue).toBe("second");
      expect(calls).toBe(2);
    } catch (err) {
      dumpLibraryErrorSnapshot("dedup-after-resolve", { firstValue, secondRunValue, calls });
      throw err;
    }
  });
});

describe("offline-mode classification", () => {
  it("treats backend-unreachable errors as remote-unreachable (→ open local, offline mode)", () => {
    const reachable = [
      "Unable to connect. Is the computer able to access the url?", // runtime sendCommand
      "RuntimeCommandFailedError: Unable to connect",
      "connect ECONNREFUSED 127.0.0.1:3000",
      "getaddrinfo ENOTFOUND api.spacebadger",
      "request to https://api timed out (ETIMEDOUT)",
      "socket hang up",
      "fetch failed",
      "TypeError: Failed to fetch",
      "network error",
      "runtime_jobs_unreachable",
      // NB: "SYNC_UNAVAILABLE" is intentionally NOT matched here — it's the
      // transient-sync case handled by an exact-match branch (→ "recovering"
      // banner), distinct from offline mode.
    ];
    for (const m of reachable) {
      try {
        expect(isRemoteUnreachableError(m)).toBe(true);
        expect(isRemoteUnreachableError(new Error(m))).toBe(true);
      } catch (err) {
        dumpLibraryErrorSnapshot("remote-unreachable-true", { input: m });
        throw err;
      }
    }
  });

  it("does NOT treat decrypt / format-too-new / generic errors as remote-unreachable", () => {
    const notUnreachable = [
      "DECRYPT_FAILED",
      "MANIFEST_DECRYPT_FAILED while fetching",
      "LIBRARY_FORMAT_TOO_NEW: schema observed=999 supported=12",
      "Could not load your library database.",
      "some unrelated error",
      "",
    ];
    for (const m of notUnreachable) {
      try {
        expect(isRemoteUnreachableError(m)).toBe(false);
      } catch (err) {
        dumpLibraryErrorSnapshot("remote-unreachable-false", { input: m });
        throw err;
      }
    }
  });

  it("recognizes the offline-mode fallback banner message (distinct from sync-unavailable)", () => {
    expect(isOfflineModeFallbackMessage(OFFLINE_MODE_FALLBACK_MESSAGE)).toBe(true);
    expect(isOfflineModeFallbackMessage(` ${OFFLINE_MODE_FALLBACK_MESSAGE} `)).toBe(true);
    // The two fallback states are distinct — neither helper matches the other's
    // message, so Library/Dashboard filter + banner only on true offline mode.
    expect(isOfflineModeFallbackMessage(SYNC_UNAVAILABLE_FALLBACK_MESSAGE)).toBe(false);
    expect(isSyncUnavailableFallbackMessage(OFFLINE_MODE_FALLBACK_MESSAGE)).toBe(false);
    expect(isOfflineModeFallbackMessage(null)).toBe(false);
    expect(isOfflineModeFallbackMessage("Could not load your library database.")).toBe(false);
  });

  it("@bugfix @regression-proof treats an IPC-wrapped SYNC_UNAVAILABLE open failure as the sync-unavailable fallback", () => {
    // Real Electron: `ipcRenderer.invoke` rejects with the main-process error
    // message prefixed — this exact string was observed in the desktop-e2e CI
    // run 7463 renderer log (library-format-too-new-gate). Pre-fix the
    // exact-match `=== "SYNC_UNAVAILABLE"` never matched it, so load() skipped
    // the openLocal fallback and dead-ended on "Could not load your library
    // database." (and never surfaced LibraryFormatTooNew from openLocal).
    const cases: Array<{ input: unknown; expected: LibraryOpenFallbackKind }> = [
      { input: new Error("SYNC_UNAVAILABLE"), expected: "sync_unavailable" },
      {
        input: new Error("Error invoking remote method 'sf-library-db-open': Error: SYNC_UNAVAILABLE"),
        expected: "sync_unavailable",
      },
      {
        input: new Error("Error invoking remote method 'sf-library-db-open': TypeError: fetch failed"),
        expected: "offline",
      },
      {
        input: new Error("Error invoking remote method 'sf-library-db-open': Error: DECRYPT_FAILED"),
        expected: null,
      },
      {
        input: new Error(
          "Error invoking remote method 'sf-library-db-open': Error: LIBRARY_FORMAT_TOO_NEW: schema:core observed=999 supported=12",
        ),
        expected: null,
      },
      { input: new Error("SYNC_UNAVAILABLE_SOMETHING_ELSE"), expected: null },
    ];
    const computed = cases.map(({ input, expected }) => ({
      input: getLibraryLoadErrorMessage(input),
      expected,
      actual: classifyLibraryOpenFallback(input),
    }));
    console.info(`[library-context-errors:open-fallback] computed=${JSON.stringify(computed)}`);
    try {
      for (const row of computed) {
        expect(row.actual, row.input).toBe(row.expected);
      }
    } catch (err) {
      dumpLibraryErrorSnapshot("open-fallback", computed);
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Offline -> online auto-recovery classifiers.
//
// @bugfix offline-mode-no-auto-recovery-2026-06-04
// @regression-proof Reported: "I started the dev stack while the app was
//   already running in offline mode but it hasn't picked up on the server being
//   accessible again." Root cause: the only recovery trigger was the window
//   'online' event (navigator.onLine / OS link-state), which never fires when
//   the OS network was up the whole time and only the backend was down. The fix
//   adds a backend-reachability poll gated by these pure classifiers. Pre-fix
//   the imported symbols don't exist, so this whole block fails to import.
// ---------------------------------------------------------------------------
describe("offline -> online recovery classification", () => {
  it("shouldPollForBackendRecovery is true ONLY in offline mode with a token", () => {
    const cases: Array<{ error: string | null; token: string | null; want: boolean }> = [
      { error: OFFLINE_MODE_FALLBACK_MESSAGE, token: "tok", want: true },
      { error: ` ${OFFLINE_MODE_FALLBACK_MESSAGE} `, token: "tok", want: true },
      { error: OFFLINE_MODE_FALLBACK_MESSAGE, token: null, want: false }, // no token to probe with
      { error: OFFLINE_MODE_FALLBACK_MESSAGE, token: "", want: false },
      { error: null, token: "tok", want: false }, // online / not offline
      { error: SYNC_UNAVAILABLE_FALLBACK_MESSAGE, token: "tok", want: false }, // transient surface, not offline mode
      { error: SYNC_UNAVAILABLE_BLOCKING_MESSAGE, token: "tok", want: false },
      { error: "Could not load your library database.", token: "tok", want: false }, // hard fail
    ];
    for (const c of cases) {
      try {
        expect(shouldPollForBackendRecovery(c.error, c.token)).toBe(c.want);
      } catch (err) {
        dumpLibraryErrorSnapshot("should-poll", c);
        throw err;
      }
    }
  });

  it("isReconnectProbeStillDown: injected timeout + connection errors keep polling", () => {
    // The probe always rejects with `new Error(...)` (the timeout race) or an
    // Error/ApiError from getLibraryMeta — never a bare string — so every input
    // here is Error-shaped.
    const stillDown: unknown[] = [
      new Error(RECONNECT_PROBE_TIMEOUT_MESSAGE), // our own race-timeout = treat as down
      new Error("ECONNREFUSED 127.0.0.1:3000"),
      new Error("fetch failed"),
      new Error("Unable to connect. Is the computer able to access the url?"),
      new Error("socket hang up"),
      new Error("runtime_unreachable"),
    ];
    for (const e of stillDown) {
      try {
        expect(isReconnectProbeStillDown(e)).toBe(true);
      } catch (err) {
        dumpLibraryErrorSnapshot("still-down-true", { input: String(e) });
        throw err;
      }
    }
  });

  it("isReconnectProbeStillDown: reachable-but-erroring backend (401/500) is UP -> stop polling, reload", () => {
    // ApiError surfaces as its payload.error string via getLibraryLoadErrorMessage,
    // so a plain Error with the same message is behaviorally identical here. A
    // backend that ACCEPTS the request and returns an auth/server error is
    // reachable -> we want to reload() and let load() own the hard-fail decision.
    const reachable: unknown[] = [
      new Error("unauthorized"), // 401
      new Error("request_failed"), // generic ApiError default
      new Error("internal_error"), // 500
      new Error("decrypt_failed"), // excluded from reachability -> not "still down"
      new Error("library_format_too_new"),
      new Error("boom"),
    ];
    for (const e of reachable) {
      try {
        expect(isReconnectProbeStillDown(e)).toBe(false);
      } catch (err) {
        dumpLibraryErrorSnapshot("still-down-false", { input: String(e) });
        throw err;
      }
    }
  });

  it("exposes a finite poll interval and timeout (timeout < interval so a hung probe re-arms)", () => {
    expect(RECONNECT_PROBE_INTERVAL_MS).toBe(10_000);
    expect(RECONNECT_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(RECONNECT_PROBE_TIMEOUT_MS).toBeLessThan(RECONNECT_PROBE_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// Source-assertion guard for the recovery poll EFFECT wiring.
//
// @bugfix offline-mode-no-auto-recovery-2026-06-04
// @regression-proof There is no RTL harness that mounts LibraryProvider, so we
//   pin the recovery wiring at the source level (the established badger pattern
//   — see library-context-no-snapshot-refresh.test.ts). The behavioural proof
//   is the live CDP run; this guard fails loudly if the poll effect, the probe
//   call, the reload() trigger, or the timeout race is ever removed.
// ---------------------------------------------------------------------------
describe("@bugfix @regression-proof backend-recovery poll effect is wired", () => {
  // Anchor to THIS test file (cwd-independent) so the guard works whether
  // vitest runs from the package dir or the repo root.
  const sourcePath = fileURLToPath(
    new URL("../src/renderer/src/lib/libraryContext.tsx", import.meta.url)
  );
  const source = readFileSync(sourcePath, "utf8");

  it("polls getLibraryMeta gated by shouldPollForBackendRecovery and calls reload() on reachable", () => {
    const required = [
      "shouldPollForBackendRecovery(error, token)", // the gate
      "getLibraryMeta(probeToken)", // the cheap probe
      "RECONNECT_PROBE_TIMEOUT_MESSAGE", // the timeout race (hung-backend guard)
      "Promise.race", // race probe vs timeout
      "isReconnectProbeStillDown(err)", // keep-polling decision
      "reload();", // the recovery trigger
    ];
    for (const needle of required) {
      try {
        expect(source.includes(needle)).toBe(true);
      } catch (err) {
        dumpLibraryErrorSnapshot("recovery-wiring", { missing: needle });
        throw err;
      }
    }
  });

  it("tears the poll down (clearTimeout + cancelled guard) so it cannot storm or leak", () => {
    expect(source.includes("window.clearTimeout(timer)")).toBe(true);
    expect(source.includes("cancelled = true")).toBe(true);
    // The effect re-arms on still-down (recursive setTimeout, single-flight).
    expect(source.includes("window.setTimeout(runProbe, RECONNECT_PROBE_INTERVAL_MS)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Online -> offline auto-switch (the SYMMETRIC counterpart of the recovery
// poll). When the app is open and online and the backend dies mid-session, the
// app must AUTO-switch into offline mode with no user interaction.
//
// @bugfix online-no-auto-offline-2026-06-04
// @regression-proof Reported: the recovery poll (offline->online) shipped but
//   the inverse trigger did not — an online session whose backend went down
//   silently kept showing the full (stale) library with a dead SSE stream and
//   never flipped to the offline banner. FAILED-OP-DRIVEN fix: the sync stream's
//   30s fallback poll already calls getLibraryMeta; on a NON-401 failure it now
//   hands the provider an onBackendUnreachable HINT, which confirmBackendOutage
//   confirms with one raced probe before reload()ing into offline mode. Pre-fix
//   the imported symbol (shouldConfirmBackendOutage) doesn't exist, so this whole
//   block fails to import. The gate must be the EXACT complement of
//   shouldPollForBackendRecovery so the confirmation and the recovery poll can
//   never both reload() (no flap loop).
// ---------------------------------------------------------------------------
describe("online -> offline outage confirmation classification", () => {
  it("shouldConfirmBackendOutage is true ONLY with a token AND not already offline", () => {
    const cases: Array<{ error: string | null; token: string | null; want: boolean }> = [
      { error: null, token: "tok", want: true }, // healthy online session — confirm hints
      { error: SYNC_UNAVAILABLE_FALLBACK_MESSAGE, token: "tok", want: true }, // non-offline surface — confirm still allowed (probe gates the flip)
      { error: null, token: null, want: false }, // no token to probe with
      { error: null, token: "", want: false },
      { error: OFFLINE_MODE_FALLBACK_MESSAGE, token: "tok", want: false }, // already offline -> recovery poll owns it
      { error: ` ${OFFLINE_MODE_FALLBACK_MESSAGE} `, token: "tok", want: false }, // trimmed match
    ];
    for (const c of cases) {
      try {
        expect(shouldConfirmBackendOutage(c.error, c.token)).toBe(c.want);
      } catch (err) {
        dumpLibraryErrorSnapshot("should-confirm", c);
        throw err;
      }
    }
  });

  it("@regression-proof outage confirmation and recovery poll are MUTUALLY EXCLUSIVE in offline mode", () => {
    // The core no-flap-loop guarantee: the moment we are in offline mode (the
    // only state the recovery poll arms in), the outage confirmation disarms —
    // they can never both reload() for the same `error`. Walk the full set of
    // error surfaces the provider can hold.
    const errors: Array<string | null> = [
      null,
      OFFLINE_MODE_FALLBACK_MESSAGE,
      ` ${OFFLINE_MODE_FALLBACK_MESSAGE} `,
      SYNC_UNAVAILABLE_FALLBACK_MESSAGE,
      SYNC_UNAVAILABLE_BLOCKING_MESSAGE,
      "Could not load your library database.",
      "Missing encryption key. Please set it again.",
    ];
    for (const error of errors) {
      const confirm = shouldConfirmBackendOutage(error, "tok");
      const recover = shouldPollForBackendRecovery(error, "tok");
      try {
        // In offline mode: recover armed, confirm disarmed. Otherwise: confirm
        // may be armed but recover is NOT. They are never both true.
        expect(confirm && recover).toBe(false);
      } catch (err) {
        dumpLibraryErrorSnapshot("mutual-exclusion", { error, confirm, recover });
        throw err;
      }
    }
  });

  it("reuses isReconnectProbeStillDown so a confirmed-down verdict matches load()'s offline classification", () => {
    // The confirmation counts a probe as "down" with the SAME predicate the
    // recovery poll uses, which in turn is built on isRemoteUnreachableError —
    // the same classifier load()'s catch uses to decide offlineMode. This
    // guarantees we only flip offline when load() would ALSO classify offline (so
    // the reload() can't bounce straight back to online).
    expect(isReconnectProbeStillDown(new Error(RECONNECT_PROBE_TIMEOUT_MESSAGE))).toBe(true);
    expect(isReconnectProbeStillDown(new Error("ECONNREFUSED 127.0.0.1:3000"))).toBe(true);
    expect(isReconnectProbeStillDown(new Error("fetch failed"))).toBe(true);
    // Reachable-but-erroring is UP -> NOT a confirmed outage (auth/hard-fail own it).
    expect(isReconnectProbeStillDown(new Error("unauthorized"))).toBe(false);
    expect(isReconnectProbeStillDown(new Error("decrypt_failed"))).toBe(false);
  });

  it("isRemoteUnreachableError matches the connection-class strings the stream hint carries", () => {
    // The stream fires onBackendUnreachable on any NON-401 fallback-poll failure;
    // the provider's confirmation probe re-classifies, but document that the
    // connection-class strings the failed op produces are recognized as down.
    expect(isRemoteUnreachableError(new Error("fetch failed"))).toBe(true);
    expect(isRemoteUnreachableError(new Error("runtime_unreachable"))).toBe(true);
    expect(isRemoteUnreachableError(new Error("decrypt_failed"))).toBe(false); // excluded -> hard fail
  });
});

// ---------------------------------------------------------------------------
// Source-assertion guard for the online -> offline FAILED-OP confirmation.
//
// @bugfix online-no-auto-offline-2026-06-04
// @regression-proof Same rationale as the recovery-poll guard: no RTL harness
//   mounts LibraryProvider, so we pin the wiring at the source level. Fails
//   loudly if the confirmation callback, its gate, the probe+timeout race, the
//   single-flight guard, the stale re-check, or the reload() trigger is removed,
//   or if the stream's onBackendUnreachable hint is unwired.
// ---------------------------------------------------------------------------
describe("@bugfix @regression-proof online->offline outage confirmation is wired", () => {
  const sourcePath = fileURLToPath(
    new URL("../src/renderer/src/lib/libraryContext.tsx", import.meta.url)
  );
  const source = readFileSync(sourcePath, "utf8");
  const streamPath = fileURLToPath(
    new URL("../src/renderer/src/lib/libraryRemoteSyncStream.ts", import.meta.url)
  );
  const streamSource = readFileSync(streamPath, "utf8");

  it("confirms via a raced getLibraryMeta gated by shouldConfirmBackendOutage and reload()s on still-down", () => {
    const required = [
      "shouldConfirmBackendOutage(errorRef.current, token)", // the gate (complement of recovery)
      "getLibraryMeta(probeToken)", // the cheap probe (shared with recovery)
      "RECONNECT_PROBE_TIMEOUT_MESSAGE", // the timeout race (hung-backend guard)
      "Promise.race", // race probe vs timeout
      "isReconnectProbeStillDown(err)", // down-vs-up decision (shared classifier)
      "confirmOutageInFlightRef.current", // single-flight guard (no probe storm)
      "reload();", // the offline trigger (shared actuator)
    ];
    for (const needle of required) {
      try {
        expect(source.includes(needle)).toBe(true);
      } catch (err) {
        dumpLibraryErrorSnapshot("confirm-wiring", { missing: needle });
        throw err;
      }
    }
  });

  it("does NOT set the offline error directly (reload() + load()'s catch own it)", () => {
    // The confirmation must only reload(); load()'s catch is the single source of
    // the OFFLINE_MODE_FALLBACK_MESSAGE. Guard: the confirm block calls reload()
    // and never calls setError.
    const start = source.indexOf("const confirmBackendOutage = useCallback");
    const end = source.indexOf("const activateRemoteLibrary = useCallback");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block.includes("reload();")).toBe(true);
    expect(block.includes("setError(")).toBe(false);
  });

  it("wires the stream hint: fallback poll fires onBackendUnreachable on a non-401 failure, and the provider passes confirmBackendOutage", () => {
    // Provider passes the callback into the stream.
    expect(source.includes("onBackendUnreachable: confirmBackendOutage")).toBe(true);
    // Stream fires the hint on a non-401 failure (after the 401 forced-logout
    // early-return), gated on navigator.onLine and on no external mpv session (#25 M3-obs).
    expect(streamSource.includes('onBackendUnreachable?.("fallback_poll_failed")')).toBe(true);
    expect(streamSource.includes("if (navigator.onLine && !externalMpvSessionActiveRef.current)")).toBe(true);
  });
});
