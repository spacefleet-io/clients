/**
 * Unpaid on Parrot desktop (ACCT-UNPAID-05, UX-NOTICE-08): the same small chip as Badger's, in the top bar's status
 * slot on every page, never a strip that pushes the page down. One or two words on screen; its accessible label and
 * tooltip carry the whole notice (`@space/shared/unpaidAccessSign`). It opens Settings ▸ Account, where the plan
 * panel renews it: the computer may point to renewing (ACCT-PAY-02 limits the phone and TV).
 *
 * The access is read from main (`getAccountAccess`, the `/auth/me` access) when the page opens and each time the
 * window comes back to the front, so a renewal made elsewhere clears the sign; it is judged against the clock at
 * render. No polling.
 */
import { useEffect, useState } from "react";
import { DesktopStatusChip } from "@space/desktop-shell/components";
import type { AccountAccess } from "@space/shared/accountAccess";
import { unpaidAccessSignText } from "@space/shared/unpaidAccessSign";
import type { ParrotLanguage } from "../../shared/ipc";

export function UnpaidAccessSign({ language, onOpen }: { language: ParrotLanguage; onOpen: () => void }) {
  const [access, setAccess] = useState<AccountAccess | null>(null);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const result = await window.parrot.getAccountAccess();
        if (alive && result.ok) setAccess(result.value);
      } catch (error) {
        console.warn("[parrot:unpaid-sign] access unavailable", error instanceof Error ? error.message : String(error));
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      window.removeEventListener("focus", read);
    };
  }, []);

  const text = unpaidAccessSignText(access, language);
  if (!text) return null;
  return (
    <DesktopStatusChip
      testId="unpaid-access-sign"
      data={{ "data-wipe-at": text.wipeAt ?? "" }}
      sign={text.sign}
      message={text.message}
      onClick={onOpen}
    />
  );
}
