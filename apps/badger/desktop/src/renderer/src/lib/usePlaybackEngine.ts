import type { UsePlaybackEngineParams } from "@/lib/playbackTypes";
import { useMpvPlaybackEngine } from "@/lib/useMpvPlaybackEngine";

export const usePlaybackEngine = (params: UsePlaybackEngineParams) => useMpvPlaybackEngine(params);
