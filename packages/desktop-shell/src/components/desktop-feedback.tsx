import { useState } from "react";
import { Button } from "@space/ui";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { FEEDBACK_MESSAGE_MAX } from "@space/shared/feedback";
import { desktopFeedbackStrings } from "./desktop-feedback-strings";

/** What the form hands the app: the trimmed message (at most `FEEDBACK_MESSAGE_MAX`) and whether the user ticked "Attach the app's error log". */
export type DesktopFeedbackInput = { message: string; attachLog: boolean };

export type DesktopFeedbackDialogProps = {
  language: ClientUiLanguage;
  /** Sends through the app's main process (`createDesktopFeedbackSender` from `@space/error-report`), which holds the session. */
  send: (input: DesktopFeedbackInput) => Promise<{ ok: boolean }>;
  onClose: () => void;
};

/**
 * "Send feedback" (UX-SUP-05), one form for Badger desktop and Parrot desktop (REL-FAM-05): the error log goes along
 * only when the user ticks the box, unticked by default (UX-SUP-02). Each app opens it from its Settings and passes
 * the send call that reaches its own main process.
 */
export function DesktopFeedbackDialog({ language, send, onClose }: DesktopFeedbackDialogProps) {
  const text = desktopFeedbackStrings[language];
  const [message, setMessage] = useState("");
  const [attachLog, setAttachLog] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60" data-testid="feedback-dialog">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-card p-6">
        <h2 className="text-lg font-semibold">{text.title}</h2>
        {/* Several lines, like the phones' form; Enter adds a line and only the button sends (no key shortcut, as
            neither the phone form nor Parrot's old form had one). Like the phones' form, the box stops at the API's
            limit and the send cuts the trimmed message to it, so a message over the limit never leaves the app. */}
        <textarea
          rows={5}
          maxLength={FEEDBACK_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label={text.title}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="feedback-message"
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={attachLog}
            onChange={(e) => setAttachLog(e.target.checked)}
            data-testid="feedback-attach-log"
          />
          <span>
            {text.attachLog}
            <span className="block text-xs text-muted-foreground">{text.attachLogHint}</span>
          </span>
        </label>
        {result && <p className="text-sm">{result}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {text.cancel}
          </Button>
          <Button
            disabled={!message.trim()}
            data-testid="feedback-send"
            onClick={async () => {
              const sent = await send({ message: message.trim().slice(0, FEEDBACK_MESSAGE_MAX), attachLog }).catch(() => ({ ok: false }));
              setResult(sent.ok ? text.sent : text.error);
              if (sent.ok) setMessage("");
            }}
          >
            {text.send}
          </Button>
        </div>
      </div>
    </div>
  );
}
