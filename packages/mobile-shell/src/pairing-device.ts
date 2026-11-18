// The name a phone gives itself when it asks to be paired (ACCT-PAIR-05): "Badger (Pixel 8)", "Parrot (iPhone)". The
// approver reads "<App> on <name> wants to sign in", so the name says which app asks and on which phone.
import { Platform } from "react-native";
import { clampDeviceName } from "@space/pairing-crypto";

export type PhonePairingAppName = "Badger" | "Parrot";

/** "<App> (<model>)", or "<App> (phone)" when the model is unknown. */
export const phoneDeviceName = (app: PhonePairingAppName, model: string | null | undefined): string => {
  const fallback = `${app} (phone)`;
  const shown = (model ?? "").trim();
  return clampDeviceName(shown ? `${app} (${shown})` : fallback, fallback);
};

/** Android's `Build.MODEL` ("Pixel 8", "ONEPLUS A6003"); "iPhone" on iOS, which does not tell the model. */
export const phoneModel = (): string | null => {
  const constants = Platform.constants as unknown as Record<string, unknown>;
  if (typeof constants.Model === "string") return constants.Model;
  return Platform.OS === "ios" ? "iPhone" : null;
};

/** This phone's pairing name for `app`. */
export const currentPhoneDeviceName = (app: PhonePairingAppName): string => phoneDeviceName(app, phoneModel());
