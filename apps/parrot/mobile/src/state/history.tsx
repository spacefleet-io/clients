// The active profile's listening history on this phone (PAR-HOME-02, ACCT-PROF-01), for Home: loaded from AsyncStorage
// when a profile is picked, and kept up to date from the player's states (a new song records a play, a playing song its
// position every few seconds and on pause). Only this phone writes it; it never leaves the phone.
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AudioPlayback, type AudioPlaybackState } from "@space/mobile-audio-playback";
import { emptyHistory, HISTORY_POSITION_EVERY_MS, type ListeningHistory } from "@space/parrot-core";
import { historyStep, loadHistory, saveHistory, type HistoryOwner } from "../lib/history";
import { nowPlayingTitles } from "../lib/nowPlaying";

const HistoryContext = createContext<ListeningHistory>(emptyHistory());

export const useListeningHistory = (): ListeningHistory => useContext(HistoryContext);

export const HistoryProvider = ({ owner: { userId, profileId, isMain }, children }: { owner: HistoryOwner; children: React.ReactNode }) => {
  const [history, setHistory] = useState<ListeningHistory>(emptyHistory);
  const current = useRef<ListeningHistory>(history);
  const lastMediaId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    // Another profile's history never shows nor takes a play while this one loads.
    let loaded = false;
    current.current = emptyHistory();
    setHistory(current.current);
    const owner = { userId, profileId, isMain };
    const apply = (next: ListeningHistory) => {
      if (next === current.current) return;
      current.current = next;
      setHistory(next);
      void saveHistory(owner, next);
    };
    const step = (state: AudioPlaybackState) => {
      if (!live || !loaded) return;
      apply(historyStep(current.current, lastMediaId.current, state, nowPlayingTitles, Date.now()));
      if (state.mediaId) lastMediaId.current = state.mediaId;
    };
    void loadHistory(owner).then((history) => {
      if (!live) return;
      loaded = true;
      current.current = history;
      setHistory(history);
      // What was already playing at sign-in is not a new play: only its position is kept from here on.
      void AudioPlayback.getState().then((state) => {
        lastMediaId.current = state.mediaId;
      }, () => undefined);
    });
    const subscription = AudioPlayback.onState(step);
    const timer = setInterval(() => {
      void AudioPlayback.getState().then((state) => (state.playing ? step(state) : undefined), () => undefined);
    }, HISTORY_POSITION_EVERY_MS);
    return () => {
      live = false;
      subscription.remove();
      clearInterval(timer);
    };
  }, [userId, profileId, isMain]);

  return <HistoryContext.Provider value={history}>{children}</HistoryContext.Provider>;
};
