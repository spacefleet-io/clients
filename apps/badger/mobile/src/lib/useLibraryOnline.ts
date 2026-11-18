import { useNetworkOnline } from "./networkListener";
import { useLibraryStatus } from "../store/library";

/**
 * Whether titles can stream right now (OFFL-PLAY-03): the phone has a network AND the library did not fall back to its
 * cache because the API was unreachable. Either one failing is offline; both recover on their own (the download
 * engine's network check, and the library's reload on network recovery), so the grey lifts without a restart.
 */
export const useLibraryOnline = (): boolean => {
  const network = useNetworkOnline();
  const { loadStatus } = useLibraryStatus();
  return network && !(loadStatus.kind === "offline" && loadStatus.reason === "network");
};
