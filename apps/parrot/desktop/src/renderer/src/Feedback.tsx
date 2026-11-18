import { useState } from "react";
import { Button, Input } from "@space/ui";
import type { Translate } from "./i18n";

/** "Send feedback" (UX-SUP-05): the error log goes along only when the user ticks the box, unticked by default. */
export function Feedback({ t, onClose }: { t: Translate; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [attachLog, setAttachLog] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-card p-6">
        <h2 className="text-lg font-semibold">{t("feedback.title")}</h2>
        <Input value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={attachLog}
            onChange={(e) => setAttachLog(e.target.checked)}
            data-testid="feedback-attach-log"
          />
          <span>
            {t("feedback.attachLog")}
            <span className="block text-xs text-muted-foreground">{t("feedback.attachLogHint")}</span>
          </span>
        </label>
        {result && <p className="text-sm">{result}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("feedback.cancel")}
          </Button>
          <Button
            disabled={!message.trim()}
            onClick={async () => {
              const sent = await window.parrot.sendFeedback({ message: message.trim(), attachLog });
              setResult(sent.ok ? t("feedback.sent") : t("feedback.error"));
              if (sent.ok) setMessage("");
            }}
          >
            {t("feedback.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
