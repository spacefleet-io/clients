// The phone's own notification permission prompt, shown at the setup's notifications step (UX-SETUP-03, UX-SETUP-06).
// Android 13+ asks at run time (POST_NOTIFICATIONS, declared in the app's manifest); older Android grants it with the
// install. iOS asks through the push setup of the app that sends pushes, so here it only records the answer.
import { PermissionsAndroid, Platform } from "react-native";

export type NotificationPermission = "granted" | "denied" | "notNeeded";

export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return "notNeeded";
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  return result === PermissionsAndroid.RESULTS.GRANTED ? "granted" : "denied";
};
