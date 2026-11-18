/**
 * ACCT-STREAM-02 on Parrot desktop: the shared prompt (`@space/ui/stream-slot-prompt`) over the gate that runs in main
 * (`src/main/streamSlot.ts`); its state arrives over `onStreamState`, the answers go back over IPC.
 */
import { StreamSlotPrompt as SharedStreamSlotPrompt, useStreamSlotState } from "@space/ui/stream-slot-prompt";
import type { StreamSlotGateState } from "@space/stream-slots";

let current: StreamSlotGateState = { kind: "idle" };
const listeners = new Set<() => void>();
let listening = false;

const publish = (next: StreamSlotGateState) => {
  current = next;
  for (const listener of [...listeners]) listener();
};

/** The main-side gate's state, mirrored in the window. */
export const streamSlotState = {
  subscribe: (listener: () => void): (() => void) => {
    if (!listening) {
      listening = true;
      window.parrot.onStreamState(publish);
      void window.parrot.getStreamState().then(publish, () => undefined);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: (): StreamSlotGateState => current,
};

export function StreamSlotPrompt({ language, closeLabel }: { language: string; closeLabel: string }) {
  return (
    <SharedStreamSlotPrompt
      state={useStreamSlotState(streamSlotState)}
      language={language}
      closeLabel={closeLabel}
      onAnswer={(answer) => void window.parrot.streamAnswer(answer)}
      onDismiss={() => void window.parrot.streamDismiss()}
    />
  );
}
