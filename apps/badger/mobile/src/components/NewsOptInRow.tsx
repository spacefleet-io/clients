import React, { memo, useCallback, useState } from "react";
import { updateSettings, type User } from "@space/shared/api";
import { newsOptInText } from "@space/legal";
import { SwitchRow } from "./SettingsRows";

type NewsOptInRowProps = {
  token: string;
  user: User | null;
  /** Receives the account as the server saved it. */
  onUser: (user: User) => void;
  /** UI language code; the wording comes from `@space/legal`, the same words as every other client. */
  language: string;
};

/**
 * ACCT-NEWS-01: News emails on or off, stored on the account. The switch shows the saved value, never a guess: it
 * moves only once the server answers, and a failed save leaves it where it was.
 */
export const NewsOptInRow = memo(({ token, user, onUser, language }: NewsOptInRowProps) => {
  const [saving, setSaving] = useState(false);
  const onChange = useCallback(
    async (newsOptIn: boolean) => {
      if (saving) return;
      setSaving(true);
      try {
        const result = await updateSettings(token, { newsOptIn });
        onUser(result.user);
        console.info("[settings] news opt-in saved", JSON.stringify({ newsOptIn: result.user.newsOptIn }));
      } catch (error) {
        console.warn("[settings] news opt-in save failed", String(error));
      } finally {
        setSaving(false);
      }
    },
    [onUser, saving, token],
  );
  const text = newsOptInText(language);
  return (
    <SwitchRow title={text.news} description={text.newsHint} value={user?.newsOptIn === true} onValueChange={(on) => void onChange(on)} />
  );
});
NewsOptInRow.displayName = "NewsOptInRow";
