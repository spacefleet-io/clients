import type { MpvClient } from "@space/mpv-protocol";

/**
 * MPV-SHOW-01: the app window hides only once mpv's own window is on screen.
 *
 * mpv answers its IPC socket long before it shows a window: the socket comes
 * up during startup, the window only once the video output is configured
 * (`vo-configured`; with `--force-window=yes` that is the VO's first reconfig,
 * which maps / shows the window). In between mpv loads the GPU driver and
 * creates its context: 0.15 s warm and 1.9 s cold on Linux (NVIDIA), longer on
 * a cold Windows start. Hiding the app window at socket time left the user
 * looking at nothing for that long.
 */
export const MPV_WINDOW_SHOWN_TIMEOUT_MS = 8_000;

export type MpvWindowShownResult = {
  /** `already`: configured when asked; `observed`: became configured; `timeout` / `exited`: never shown. */
  via: "already" | "observed" | "timeout" | "exited";
  waitedMs: number;
};

type ExitSource = {
  on(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
};

/**
 * Resolves once `client`'s mpv window is shown (`vo-configured` true), when mpv
 * exits, or after `timeoutMs`. Never rejects: the caller hides the app window
 * whatever the answer, so a VO that never reports still ends the hand-off.
 */
export const waitForMpvWindowShown = (
  client: Pick<MpvClient, "getProperty" | "observe"> & ExitSource,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<MpvWindowShownResult> => {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { promise, resolve } = Promise.withResolvers<MpvWindowShownResult>();
  let settled = false;
  // Observe before reading, so a reconfig between the read and the
  // subscription cannot be missed.
  const unobserve = client.observe("vo-configured", (value) => {
    if (value === true) finish("observed");
  });
  const onExit = () => finish("exited");
  client.on("exit", onExit);
  const timer = setTimeout(() => finish("timeout"), options.timeoutMs ?? MPV_WINDOW_SHOWN_TIMEOUT_MS);
  function finish(via: MpvWindowShownResult["via"]) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unobserve();
    client.off("exit", onExit);
    resolve({ via, waitedMs: now() - startedAt });
  }
  void client.getProperty("vo-configured").then(
    (value) => {
      if (value === true) finish("already");
    },
    () => undefined,
  );
  return promise;
};
