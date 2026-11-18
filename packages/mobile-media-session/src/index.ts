// @space/mobile-media-session: the phone apps' operating system media session (PLAY-OSMEDIA-01). The native
// `SpaceMediaSession` module shows the notification-shade and lock-screen card and answers headset buttons (Android:
// a Media3 MediaSessionService whose player mirrors the plan; iOS: Now Playing and the remote command center); this
// side plans what it shows with `@space/media-session` and routes its button presses to the player's handlers.
import { AppRegistry, DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from "react-native";
import {
  createMediaSessionBinderFor,
  createNoopBinder,
  type NativeMediaSessionBinder,
  type NativeMediaSessionBinderOptions,
  type NativeMediaSessionEvent,
  type NativeMediaSessionModule,
} from "./binder";
import { createKeepAliveTask, KEEP_ALIVE_TASK } from "./keepAlive";

export {
  ACTION_EVENT,
  createMediaSessionBinderFor,
  type NativeActionSource,
  type NativeMediaSessionBinder,
  type NativeMediaSessionBinderOptions,
  type NativeMediaSessionEvent,
  type NativeMediaSessionModule,
  type NativeMediaSessionPlan,
  toNativePlan,
} from "./binder";

export { createKeepAliveTask, KEEP_ALIVE_END_EVENT, KEEP_ALIVE_TASK, type KeepAliveData, type KeepAliveEvents } from "./keepAlive";

// Android runs this task while the card plays so JS timers keep going in the background (see `keepAlive.ts`).
if (Platform.OS === "android") {
  const log = (message: string, detail?: Record<string, unknown>) => console.info(message, JSON.stringify(detail ?? {}));
  AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => createKeepAliveTask(DeviceEventEmitter, log));
}
/** What `NativeEventEmitter` needs from a native module (React Native no longer exports its `NativeModule` type). */
type EventEmitterModule = { addListener: (eventType: string) => void; removeListeners: (count: number) => void };

let missingLogged = false;

/** The binder over the linked native module; does nothing (logged once) where the module is not linked. */
export const createNativeMediaSessionBinder = (options: NativeMediaSessionBinderOptions): NativeMediaSessionBinder => {
  const native = NativeModules.SpaceMediaSession as (NativeMediaSessionModule & EventEmitterModule) | undefined;
  if (!native) {
    if (!missingLogged) {
      missingLogged = true;
      (options.log ?? console.info)("media_session.native_missing");
    }
    return createNoopBinder();
  }
  return createMediaSessionBinderFor(native, new NativeEventEmitter<Record<string, [NativeMediaSessionEvent]>>(native), options);
};
