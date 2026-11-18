import { Platform } from "react-native";
import { featureAvailability, isRouteAvailable, type FeatureRoute } from "./tvFeatures";

/** True on Android TV / Fire TV / Apple TV (the one binary also runs on phones). */
export const IS_TV: boolean = Platform.isTV;

if (IS_TV) console.info("tv.features", JSON.stringify(featureAvailability(IS_TV)));

/** `isRouteAvailable` for this device. */
export const routeAvailable = (route: FeatureRoute): boolean => isRouteAvailable(route, IS_TV);
