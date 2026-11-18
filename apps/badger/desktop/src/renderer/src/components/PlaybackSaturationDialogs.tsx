/**
 * STOR-BW-07, STOR-BW-08: the two dialogs of a saturated silo.
 *  - `refused`: the silo refused a new playback (`refusals` went up).
 *  - `stopped`: the playback in progress ended because of the saturation (`stops` went up).
 * Both counters come from the main process and only the silo decides who is refused or stopped (free accounts), so
 * a dialog opens on every increment seen after mount. Nothing resumes by itself: the user presses play again.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";

type Popup = "refused" | "stopped";

export type PlaybackSaturationDialogsProps = {
  refusals: number;
  stops: number;
  /** Opens the plans (Settings > Account). */
  onUpgrade: () => void;
};

export default function PlaybackSaturationDialogs({ refusals, stops, onUpgrade }: PlaybackSaturationDialogsProps) {
  const { t } = useTranslation();
  const [popup, setPopup] = useState<Popup | null>(null);
  const seenRefusals = useRef(refusals);
  const seenStops = useRef(stops);

  useEffect(() => {
    if (refusals > seenRefusals.current) setPopup("refused");
    seenRefusals.current = refusals;
  }, [refusals]);

  useEffect(() => {
    if (stops > seenStops.current) setPopup("stopped");
    seenStops.current = stops;
  }, [stops]);

  if (popup === null) return null;
  const close = () => setPopup(null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md border border-[#30363d] bg-[#161b22] text-white shadow-2xl">
        <DialogHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#bb800926]">
            <AlertTriangle className="h-6 w-6 text-[#d29922]" aria-hidden />
          </div>
          <DialogTitle>{t(`saturation.${popup}.title`)}</DialogTitle>
          <DialogDescription className="text-[#8b949e]">{t(`saturation.${popup}.body`)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              close();
              onUpgrade();
            }}
          >
            {t("saturation.upgrade")}
          </Button>
          <Button type="button" variant="secondary" onClick={close}>
            {t("saturation.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
