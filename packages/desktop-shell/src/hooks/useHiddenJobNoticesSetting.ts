import { useCallback, useEffect, useState } from "react";
import type { HiddenJobNoticesBridge } from "../main-shell/hiddenJobNoticesBridge";

/**
 * UX-NOTICE-06: the "notify me when a job ends while the app is hidden" switch, kept by main on this computer.
 * `value`: undefined without the bridge (browser, tests: hide the row), null while loading.
 */
export const useHiddenJobNoticesSetting = (bridge: HiddenJobNoticesBridge | undefined) => {
  const [value, setValue] = useState<boolean | null | undefined>(bridge ? null : undefined);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.getEnabled().then((enabled) => {
      if (!cancelled) setValue(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const set = useCallback(
    (next: boolean) => {
      if (!bridge) return;
      setValue(next);
      void bridge.setEnabled(next).then(setValue);
    },
    [bridge],
  );

  return { value, set };
};
