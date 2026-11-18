import { Platform } from "react-native";
import type { FeedbackDevice } from "./feedback";

type PlatformConstants = { Model?: string; Manufacturer?: string; Brand?: string; Release?: string };

/**
 * What a phone app's "Send feedback" message says about where it comes from (UX-SUP-05): the app, its version, the OS
 * and the kind of phone ("Google Pixel 8"), never anything about the user. Shared by Badger and Parrot (REL-FAM-03).
 */
export const phoneFeedbackDevice = (app: FeedbackDevice["app"], appVersion: string): FeedbackDevice => {
  const constants = (Platform.constants ?? {}) as PlatformConstants;
  const model = constants.Model?.trim() ?? "";
  const maker = (constants.Manufacturer ?? constants.Brand ?? "").trim();
  const deviceModel = model ? (maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ${model}` : model) : null;
  const osVersion = Platform.OS === "android" ? constants.Release ?? String(Platform.Version) : String(Platform.Version);
  return {
    app,
    appVersion: appVersion.slice(0, 64),
    platform: `${Platform.OS} ${osVersion}`.slice(0, 32),
    deviceModel: deviceModel ? deviceModel.slice(0, 128) : null,
  };
};
