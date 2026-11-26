import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import { Button } from "@space/ui";
import { DesktopFeedbackDialog, type DesktopFeedbackInput } from "@space/desktop-shell/components";
import { recentFailedRequestIds } from "@space/shared/apiFailure";
import { isClientUiLanguage } from "@space/shared/i18n";
import { SettingGroup, SettingRow } from "../kit";

/**
 * Settings > Help & feedback: "Send feedback" (UX-SUP-05) opens the desktop form Parrot uses too (REL-FAM-05). Main
 * sends it to `POST /feedback` with the session it holds, the error log only when the box is ticked (UX-SUP-02) and
 * the request ids of the last failed calls (UX-SUP-07): the window calls the API itself, so it hands main its own ids.
 */
export default function SupportSection() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const language = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  const bridge = window.sf?.sendFeedback;
  const send = bridge ? (input: DesktopFeedbackInput) => bridge({ ...input, requestIds: recentFailedRequestIds() }) : undefined;
  return (
    <div className="space-y-4">
      <SettingGroup>
        <SettingRow
          title={t("settings.support.feedback")}
          description={t("settings.support.feedbackBody")}
          control={
            <Button variant="outline" disabled={!send} onClick={() => setOpen(true)} data-testid="settings-feedback">
              <MessageSquare className="mr-2 size-4" aria-hidden />
              {t("settings.support.feedback")}
            </Button>
          }
        />
      </SettingGroup>
      {open && send ? <DesktopFeedbackDialog language={language} send={send} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
