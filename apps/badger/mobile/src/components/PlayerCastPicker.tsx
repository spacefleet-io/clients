import React, { useEffect, useRef } from "react";
import { CastContext, useDevices } from "react-native-google-cast";
import { CastPickerSheet } from "./CastPickerSheet";
import { usePickerSheet } from "./usePickerSheet";
import type { CastTarget } from "../lib/cast/castFlow";

type Props = {
  /** The sheet closed without a device: the player carries on here. */
  onClose: () => void;
  onTarget: (target: CastTarget) => void;
};

/**
 * The player's Cast picker (PLAY-OVL-04), phone only: the same sheet as the title page's Play button (INTG-CAST-01).
 * Mounted only while open and never on a TV, which has no Cast sender (react-native.config.js keeps the SDK out).
 */
export const PlayerCastPicker = ({ onClose, onTarget }: Props) => {
  const sheet = usePickerSheet();
  const devices = useDevices();
  const opened = useRef(false);
  // A row was picked: it hands over itself once the sheet has slid out.
  const picked = useRef(false);

  useEffect(() => {
    // As on the title page: iOS starts discovery only on request (also when it asks for Local Network access).
    void CastContext.getDiscoveryManager().startDiscovery().catch(() => undefined);
    sheet.open();
  }, []);

  // Closed by its backdrop, Back or a drag (the shared sheet reports it once slid out): hand back to the player.
  useEffect(() => {
    if (sheet.visible) opened.current = true;
    else if (opened.current && !picked.current) onClose();
  }, [onClose, sheet.visible]);

  return (
    <CastPickerSheet
      sheet={sheet}
      devices={devices}
      onPhone={() => {
        picked.current = true;
        sheet.close(onClose);
      }}
      onTarget={(target) => {
        picked.current = true;
        sheet.close(() => onTarget(target));
      }}
    />
  );
};
