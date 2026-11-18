/**
 * REL-LOG-06: the Settings "send error reports" switch of every desktop app (Badger, Parrot). The answer lives in
 * main; a change goes through the window's `RendererErrorReports`, so reporting starts or stops at once, without a
 * restart.
 */
import { useCallback, useEffect, useState } from "react";
import type { RendererErrorReports } from "./desktopRenderer";

type Log = { info(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void };

/**
 * `value`: undefined = no bridge (web build / tests), null = still loading, else whether reporting is on. An
 * unanswered question reads as off.
 */
export const useErrorReportsSetting = (errorReports: RendererErrorReports, log: Log) => {
  const [value, setValue] = useState<boolean | null | undefined>(() => (errorReports.hasBridge() ? null : undefined));

  useEffect(() => {
    if (!errorReports.hasBridge()) return;
    let cancelled = false;
    errorReports
      .get()
      .then((state) => {
        if (!cancelled && state) setValue(state.decision === "on");
      })
      .catch((err: unknown) => {
        log.error({ err: String(err) }, "[error-report] could not read this computer's answer");
      });
    return () => {
      cancelled = true;
    };
  }, [errorReports, log]);

  const set = useCallback(
    (next: boolean) => {
      const previous = value;
      setValue(next);
      log.info({ to: next ? "on" : "off" }, "[error-report] change requested");
      errorReports
        .set(next ? "on" : "off")
        .then((state) => {
          if (state) setValue(state.decision === "on");
        })
        .catch((err: unknown) => {
          log.error({ err: String(err), to: next ? "on" : "off" }, "[error-report] could not save this computer's answer");
          setValue(previous);
        });
    },
    [errorReports, log, value],
  );

  return { value, set };
};
