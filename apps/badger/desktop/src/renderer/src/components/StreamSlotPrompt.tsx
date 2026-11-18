/**
 * ACCT-STREAM-02 on Badger desktop: the shared prompt (`@space/ui/stream-slot-prompt`) over the renderer's one stream
 * gate (`lib/streamSlot.ts`). Mounted once in `AuthenticatedApp`, after the loading modal so it stacks above it.
 */
import { useTranslation } from "react-i18next";
import { StreamSlotPrompt as SharedStreamSlotPrompt, useStreamSlotState } from "@space/ui/stream-slot-prompt";
import { desktopStreamSlotGate } from "@/lib/streamSlot";

export default function StreamSlotPrompt() {
  const { t, i18n } = useTranslation();
  return (
    <SharedStreamSlotPrompt
      state={useStreamSlotState(desktopStreamSlotGate)}
      language={i18n?.language ?? "en"}
      closeLabel={t("library.close")}
      onAnswer={(answer) => desktopStreamSlotGate.answer(answer)}
      onDismiss={() => desktopStreamSlotGate.dismiss()}
    />
  );
}
