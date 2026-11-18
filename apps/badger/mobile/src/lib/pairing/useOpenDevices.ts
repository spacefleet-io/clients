import { useCallback, useEffect, useState } from "react";
import { subscribeOpenDevices } from "./newDevice";

export type OpenDevices = {
  /** Bumped each time the devices list must open (notice or notification tapped); 0 = never asked. */
  devicesRequest: number;
  /** Open Settings on "Your devices" with the device list open. */
  openDevices: () => void;
};

/**
 * "Your devices" on request (ACCT-PAIR-03): tapping the new-device notice or the notification opens Settings scrolled
 * to "Your devices" with the list open, not wherever Settings was last scrolled.
 *
 * @param showSettings switches the shell to the Settings tab.
 */
export const useOpenDevices = (showSettings: () => void): OpenDevices => {
  const [devicesRequest, setDevicesRequest] = useState(0);
  const openDevices = useCallback(() => {
    setDevicesRequest((n) => n + 1);
    showSettings();
  }, [showSettings]);
  useEffect(() => subscribeOpenDevices(openDevices), [openDevices]);
  return { devicesRequest, openDevices };
};
