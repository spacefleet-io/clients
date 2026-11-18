/**
 * ACCT-STREAM-02, drawn the same way in every app with a React window (Badger desktop, Parrot desktop, Badger and
 * Parrot web players): "Already playing on {device}. Play here instead?" (Play here / Cancel) while a player waits for
 * the answer, and "Playing on {device} now" after another device took this one's place. The text comes from
 * `@space/stream-slots`, so every player says the same thing. Closing the question (Escape, outside, ×) is Cancel.
 *
 * `useStreamSlotState(gate)` follows a `StreamSlotGate` running in the same window; Parrot desktop, whose gate runs in
 * main, passes the state it mirrors over IPC instead. `useSessionStreamSlotGate` is the web players' one gate per
 * signed-in profile in a tab.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createStreamSlotsClient,
  StreamSlotGate,
  streamSlotText,
  type StreamApp,
  type StreamSlotAnswer,
  type StreamSlotGateState,
} from "@space/stream-slots";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

export const useStreamSlotState = (gate: Pick<StreamSlotGate, "subscribe" | "getState">): StreamSlotGateState =>
  useSyncExternalStore(gate.subscribe, gate.getState, gate.getState);

export type SessionStreamSlotGateOptions = {
  app: StreamApp;
  apiBaseUrl: string;
  token: string;
  /** The profile that plays; null = the account's main profile (the server's default). */
  profileId: string | null;
};

/**
 * One `StreamSlotGate` for this signed-in session and profile (ACCT-STREAM-01..04): a new one when the token or the
 * profile changes, and the old one gives its place back (as does the last one when the screen unmounts). The player
 * stops when the state turns `takenOver`.
 */
export const useSessionStreamSlotGate = ({ app, apiBaseUrl, token, profileId }: SessionStreamSlotGateOptions): StreamSlotGate => {
  const gate = useMemo(
    () =>
      new StreamSlotGate({
        client: createStreamSlotsClient({ baseUrl: apiBaseUrl, getToken: () => token }),
        app,
        getProfileId: () => profileId,
        log: (event, fields) => console.info(`[stream-slot] ${event}`, fields),
      }),
    [app, apiBaseUrl, token, profileId]
  );
  useEffect(() => () => void gate.release(), [gate]);
  return gate;
};

export type StreamSlotPromptProps = {
  state: StreamSlotGateState;
  language: string;
  /** The app's own "Close" label, for the taken-over notice. */
  closeLabel: string;
  onAnswer: (answer: StreamSlotAnswer) => void;
  onDismiss: () => void;
};

export function StreamSlotPrompt({ state, language, closeLabel, onAnswer, onDismiss }: StreamSlotPromptProps) {
  if (state.kind !== "asking" && state.kind !== "takenOver") return null;
  const asking = state.kind === "asking";
  const text = streamSlotText(language, asking ? "alreadyPlaying" : "playingElsewhere", state.device);
  const close = () => (asking ? onAnswer("cancel") : onDismiss());
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="max-w-md" closeLabel={asking ? streamSlotText(language, "cancel") : closeLabel} data-testid="stream-slot-prompt">
        <DialogHeader>
          <DialogTitle>{text}</DialogTitle>
          <DialogDescription className="sr-only">{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {asking ? (
            <>
              <Button type="button" variant="ghost" onClick={close} data-testid="stream-slot-cancel">
                {streamSlotText(language, "cancel")}
              </Button>
              <Button type="button" onClick={() => onAnswer("playHere")} data-testid="stream-slot-play-here">
                {streamSlotText(language, "playHere")}
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={close} data-testid="stream-slot-close">
              {closeLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
