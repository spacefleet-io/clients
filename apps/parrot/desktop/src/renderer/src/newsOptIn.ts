/**
 * ACCT-NEWS-01 on Parrot desktop: the account's News opt-in behind the settings switch. The token lives in main, so
 * the value is read and saved through the bridge. `undefined`: no bridge (a browser preview), the row is hidden;
 * `null`: not read yet, or the server did not answer — the switch stays disabled rather than guess.
 */
import { useCallback, useEffect, useState } from "react";
import type { ParrotBridge } from "../../shared/ipc";

type NewsBridge = Pick<ParrotBridge, "getNewsOptIn" | "saveNewsOptIn">;

export interface NewsOptInSwitch {
  /** `undefined`: no bridge, row hidden; `null`: unread or unreadable, switch disabled. */
  value: boolean | null | undefined;
  saving: boolean;
  set: (on: boolean) => void;
}

export function useNewsOptIn(bridge: NewsBridge | undefined): NewsOptInSwitch {
  const usable = typeof bridge?.getNewsOptIn === "function" && typeof bridge.saveNewsOptIn === "function";
  const [value, setValue] = useState<boolean | null | undefined>(usable ? null : undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!usable || !bridge) return;
    let live = true;
    void bridge.getNewsOptIn().then((read) => {
      if (!live) return;
      if (read.ok) setValue(read.newsOptIn);
      else console.warn("news_opt_in.unreadable");
    });
    return () => {
      live = false;
    };
  }, [bridge, usable]);

  const set = useCallback(
    (on: boolean) => {
      if (!usable || !bridge || saving) return;
      setSaving(true);
      void bridge
        .saveNewsOptIn(on)
        .then((saved) => {
          if (saved.ok) setValue(saved.newsOptIn);
          else console.warn("news_opt_in.save_failed", JSON.stringify({ newsOptIn: on }));
        })
        .finally(() => setSaving(false));
    },
    [bridge, saving, usable],
  );

  return { value, saving, set };
}
