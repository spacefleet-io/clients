/** UX-NOTICE-06: the channels and the preload bridge of the hidden-job notifications (no Node imports: the preload loads it). */
export const HIDDEN_JOB_NOTICE_CHANNELS = {
  getSetting: "sf-hidden-job-notices-get",
  setSetting: "sf-hidden-job-notices-set",
  /** main → renderer: a Jobs request waits; call `takeOpenJobs`. */
  openJobs: "sf-open-jobs-requested",
  takeOpenJobs: "sf-open-jobs-take",
} as const;

/** The renderer's side, for the preload: the setting, and the Jobs request a click on a notification left. */
export type HiddenJobNoticesBridge = {
  getEnabled: () => Promise<boolean>;
  setEnabled: (value: boolean) => Promise<boolean>;
  /** Calls `open` now if a request waits, and on every later one; returns the unsubscribe. */
  onOpenJobs: (open: () => void) => () => void;
};

export type HiddenJobNoticesRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: () => void) => unknown;
  removeListener: (channel: string, listener: () => void) => unknown;
};

export const createHiddenJobNoticesBridge = (ipc: HiddenJobNoticesRenderer): HiddenJobNoticesBridge => ({
  getEnabled: async () => (await ipc.invoke(HIDDEN_JOB_NOTICE_CHANNELS.getSetting)) !== false,
  setEnabled: async (value) => (await ipc.invoke(HIDDEN_JOB_NOTICE_CHANNELS.setSetting, value)) !== false,
  onOpenJobs: (open) => {
    const check = () => {
      void ipc.invoke(HIDDEN_JOB_NOTICE_CHANNELS.takeOpenJobs).then((waiting) => {
        if (waiting === true) open();
      });
    };
    ipc.on(HIDDEN_JOB_NOTICE_CHANNELS.openJobs, check);
    check();
    return () => {
      ipc.removeListener(HIDDEN_JOB_NOTICE_CHANNELS.openJobs, check);
    };
  },
});
