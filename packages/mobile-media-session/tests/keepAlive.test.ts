/**
 * @req PLAY-OSMEDIA-01[badger-mobile]
 * @why With the app in the background or the screen locked, React Native stops JS timers unless a headless JS task
 *   runs, and the Badger player behind the card lives on them (snapshot poll, next episode loading). The native module
 *   (`JsKeepAlive.kt`) runs `KEEP_ALIVE_TASK` while the card plays and for a grace after each press, and ends it with
 *   `KEEP_ALIVE_END_EVENT` and the task's token; this checks the JS task waits for exactly that end. The native side is
 *   hand-tried (see PLAY-OSMEDIA-01 notes).
 */
import { describe, expect, it } from "vitest";
import { createKeepAliveTask, KEEP_ALIVE_END_EVENT, KEEP_ALIVE_TASK, type KeepAliveData } from "../src/keepAlive";

const TAG = "[mobile-media-session.keepAlive]";
const log = (step: string, detail: unknown) => console.info(`${TAG} ${step}`, JSON.stringify(detail));

const fakeEvents = () => {
  const listeners = new Set<{ name: string; listener: (event: KeepAliveData) => void }>();
  return {
    listeners,
    events: {
      addListener: (name: string, listener: (event: KeepAliveData) => void) => {
        const entry = { name, listener };
        listeners.add(entry);
        return { remove: () => listeners.delete(entry) };
      },
    },
    emit: (name: string, event: KeepAliveData) =>
      [...listeners].filter((entry) => entry.name === name).forEach((entry) => entry.listener(event)),
  };
};

describe("JS keep-alive while the card plays", () => {
  it("runs until the native side ends its own token, ignoring other tokens and events", async () => {
    const { events, emit, listeners } = fakeEvents();
    const steps: string[] = [];
    const task = createKeepAliveTask(events, (message, detail) => steps.push(`${message} ${JSON.stringify(detail)}`));
    let done = false;
    const running = task({ token: 2 }).then(() => {
      done = true;
    });
    emit(KEEP_ALIVE_END_EVENT, { token: 1 });
    emit(KEEP_ALIVE_TASK, { token: 2 });
    await Promise.resolve();
    log("after other token and event", { done, listeners: listeners.size, steps });
    expect(done).toBe(false);
    expect(listeners.size).toBe(1);

    emit(KEEP_ALIVE_END_EVENT, { token: 2 });
    await running;
    log("after own token", { done, listeners: listeners.size, steps });
    expect(done).toBe(true);
    expect(listeners.size).toBe(0);
    expect(steps).toEqual(['media_session.keep_alive_task_start {"token":2}', 'media_session.keep_alive_task_end {"token":2}']);
  });

  it("keeps the names the native module uses", () => {
    log("names", { KEEP_ALIVE_TASK, KEEP_ALIVE_END_EVENT });
    expect(KEEP_ALIVE_TASK).toBe("SpaceMediaSessionKeepAlive");
    expect(KEEP_ALIVE_END_EVENT).toBe("SpaceMediaSessionKeepAliveEnd");
  });
});
