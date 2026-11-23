import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { getApiBaseUrl } from "@space/shared/api";
import { keyValueHelloStore, noteHelloScreen, startDailyHello } from "@space/shared/dailyHello";

/**
 * OPS-BIZ-20: the window's daily hello (once per local day, a few seconds after start, silent on failure) and its
 * screen tally (each route the window opens). Renders nothing. Mounted once inside the router.
 */
export function DailyHello() {
  const { pathname } = useLocation();
  useEffect(() => {
    noteHelloScreen();
  }, [pathname]);
  useEffect(() => startDailyHello({ baseUrl: getApiBaseUrl, store: keyValueHelloStore(window.localStorage) }), []);
  return null;
}
