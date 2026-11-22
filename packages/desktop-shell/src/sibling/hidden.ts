/**
 * ACCT-PAIR-07: the hidden start. When the asking app finds its sister app signed in but not running, it starts it with
 * `--sibling-sign-in`: no window, only the local channel. That run quits shortly after answering, or after a minute
 * with no request.
 */
type Log = (message: string, extra?: Record<string, unknown>) => void;

export type SiblingHiddenQuit = { answered: () => void };

export const armSiblingHiddenQuit = (options: { quit: () => void; idleMs?: number; afterAnswerMs?: number; log?: Log }): SiblingHiddenQuit => {
  let timer = setTimeout(() => {
    options.log?.("sibling: hidden start quits, no request came");
    options.quit();
  }, options.idleMs ?? 60_000);
  return {
    answered: () => {
      clearTimeout(timer);
      // A moment for the answer to leave the socket before the app goes.
      timer = setTimeout(() => {
        options.log?.("sibling: hidden start quits after answering");
        options.quit();
      }, options.afterAnswerMs ?? 1_500);
    },
  };
};
