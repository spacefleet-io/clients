/** STOR-BW-07, STOR-BW-08: mounts the refused / stopped playback dialogs with the live state; "Upgrade plan" opens Settings (Account, the plans). */
import { useNavigate } from "react-router-dom";
import PlaybackSaturationDialogs from "@/components/PlaybackSaturationDialogs";
import { usePlaybackSaturation } from "@/lib/usePlaybackSaturation";

export default function PlaybackSaturationHost() {
  const navigate = useNavigate();
  const { refusals, stops } = usePlaybackSaturation();
  return <PlaybackSaturationDialogs refusals={refusals} stops={stops} onUpgrade={() => navigate("/settings")} />;
}
