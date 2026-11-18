import type { StreamSlotGate, StreamSlotGateState } from "./gate";
import { streamSlotText } from "./strings";

/** The slice of React Native's `Alert.alert` the phones use, so this module needs no React Native import. */
export type StreamSlotAlertButton = { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
export type StreamSlotAlert = (
  title: string,
  message?: string,
  buttons?: StreamSlotAlertButton[],
  options?: { cancelable?: boolean; onDismiss?: () => void },
) => void;

/**
 * Draws a gate's two moments with the phone's native alert (Badger phone and Parrot phone, ACCT-STREAM-02):
 * - `asking`: "Already playing on {device}. Play here instead?" with Cancel and Play here. Dismissing the alert
 *   (Android back, tap outside) is Cancel: nothing changes.
 * - `takenOver`: "Playing on {device} now", with the platform's own OK. The gate's notice is then cleared at once:
 *   the native alert stays on screen until the user closes it.
 * Returns the unsubscribe.
 */
export const bindStreamSlotAlerts = (
  gate: StreamSlotGate,
  options: { alert: StreamSlotAlert; language: () => string; log?: (event: string, fields: Record<string, unknown>) => void },
): (() => void) => {
  let shown: StreamSlotGateState | null = null;
  return gate.subscribe(() => {
    const state = gate.getState();
    if (state === shown) return;
    shown = state;
    const language = options.language();
    if (state.kind === "asking") {
      options.log?.("stream_slot.alert.asking", { device: state.device });
      options.alert(
        streamSlotText(language, "alreadyPlaying", state.device),
        undefined,
        [
          { text: streamSlotText(language, "cancel"), style: "cancel", onPress: () => gate.answer("cancel") },
          { text: streamSlotText(language, "playHere"), onPress: () => gate.answer("playHere") },
        ],
        { cancelable: true, onDismiss: () => gate.answer("cancel") },
      );
    } else if (state.kind === "takenOver") {
      options.log?.("stream_slot.alert.taken_over", { device: state.device });
      options.alert(streamSlotText(language, "playingElsewhere", state.device));
      gate.dismiss();
    }
  });
};
