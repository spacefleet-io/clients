import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import type { ToolAccessMode } from "@space/tool-access/contracts";
import { useToolAccess } from "@/lib/toolAccess";

/** A new request cannot be answered for this long after it first shows. */
const TOOL_ACCESS_ARM_DELAY_MS = 1000;

/**
 * DEV-LIB-01: a third-party tool asked to read (or change) your library through the local runtime. Nothing is
 * granted until the user approves here. The tool name is whatever the tool called itself, so the dialog says so,
 * shows the code the tool shows to its own user (to tell a request this user just started from a stranger's),
 * and offers read-only access when write was asked. Dismissing the dialog denies the request.
 *
 * A request can show up while the user is typing or clicking, so a new request (a new id, also when it replaces
 * the one on screen) cannot be answered for its first second: a stray Enter, Escape or click is not an answer.
 */
export default function ToolAccessPrompt() {
  const { t } = useTranslation();
  const access = useToolAccess();
  const request = access?.snapshot.pending[0];
  const requestId = request?.requestId ?? null;
  const [armedId, setArmedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    if (!requestId) return;
    const timer = setTimeout(() => setArmedId(requestId), TOOL_ACCESS_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [requestId]);
  if (!access || !request) return null;

  const locked = busyId === request.requestId || armedId !== request.requestId;
  const decide = async (decision: "approve" | "deny", mode?: ToolAccessMode) => {
    if (locked) return;
    setBusyId(request.requestId);
    try {
      await access.decide(request.requestId, decision, mode);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog key={request.requestId} open onOpenChange={(open) => (open ? undefined : void decide("deny"))}>
      <DialogContent className="max-w-md" data-testid="tool-access-prompt">
        <DialogHeader>
          <DialogTitle>{t("toolAccess.prompt.title", { name: request.toolName })}</DialogTitle>
          <DialogDescription>{t(`toolAccess.prompt.description.${request.mode}`)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="text-xs text-muted-foreground">{t("toolAccess.prompt.selfDeclared")}</p>
          {request.reason ? (
            <p data-testid="tool-access-reason">{t("toolAccess.prompt.reason", { reason: request.reason })}</p>
          ) : null}
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <p className="text-xs text-muted-foreground">{t("toolAccess.prompt.codeHint")}</p>
            <p className="mt-1 font-mono text-lg tracking-widest" data-testid="tool-access-code">
              {request.verificationCode}
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="secondary" disabled={locked} onClick={() => void decide("deny")}>
            {t("toolAccess.prompt.deny")}
          </Button>
          {request.mode === "write" ? (
            <Button type="button" variant="secondary" disabled={locked} onClick={() => void decide("approve", "read")}>
              {t("toolAccess.prompt.approveRead")}
            </Button>
          ) : null}
          <Button type="button" disabled={locked} onClick={() => void decide("approve")}>
            {t(`toolAccess.prompt.approve.${request.mode}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
