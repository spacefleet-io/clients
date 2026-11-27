// REL-LOG-06: exposes the error-report bridge only; it sends nothing until the user opts in.
import "@space/error-report/electron-preload";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createErrorReportsBridge } from "@space/error-report/desktop";
import { createUpdaterBridge } from "@space/desktop-shell/updater-preload";
import { createHiddenJobNoticesBridge } from "@space/desktop-shell/hidden-job-notices-preload";
import { readStorageUnitBase } from "@space/desktop-shell/storage-units";
import { SIBLING_IPC } from "@space/desktop-shell/sibling";
import { PARROT_IPC, type KeyChangeState, type ParrotBackgroundWork, type ParrotBridge, type ParrotCoverCutRequest, type ParrotExportJob, type ParrotImportJob, type ParrotImportStatus } from "../shared/ipc";
import type { ParrotLibraryPatch } from "../shared/libraryPatch";
import type { KeptStatus } from "@space/parrot-core";
import type { StreamSlotGateState } from "@space/stream-slots";
import type { AppUpdateRequiredPayload } from "@space/shared/appVersion";

const bridge: ParrotBridge = {
  getState: () => ipcRenderer.invoke(PARROT_IPC.getState),
  hiddenJobNotices: createHiddenJobNoticesBridge(ipcRenderer),
  saveSetup: (patch) => ipcRenderer.invoke(PARROT_IPC.saveSetup, patch),
  getAccountLanguage: () => ipcRenderer.invoke(PARROT_IPC.getAccountLanguage),
  saveAccountLanguage: (language) => ipcRenderer.invoke(PARROT_IPC.saveAccountLanguage, language),
  getNewsOptIn: () => ipcRenderer.invoke(PARROT_IPC.getNewsOptIn),
  saveNewsOptIn: (newsOptIn) => ipcRenderer.invoke(PARROT_IPC.saveNewsOptIn, newsOptIn),
  getFounderStatus: () => ipcRenderer.invoke(PARROT_IPC.getFounderStatus),
  markFounderNoticeSeen: () => ipcRenderer.invoke(PARROT_IPC.markFounderNoticeSeen),
  signIn: (input) => ipcRenderer.invoke(PARROT_IPC.signIn, input),
  signUp: (input) => ipcRenderer.invoke(PARROT_IPC.signUp, input),
  verifyEmail: (input) => ipcRenderer.invoke(PARROT_IPC.verifyEmail, input),
  resendVerification: (email) => ipcRenderer.invoke(PARROT_IPC.resendVerification, email),
  passwordReset: {
    request: (email) => ipcRenderer.invoke(PARROT_IPC.passwordResetRequest, email),
    confirm: (input) => ipcRenderer.invoke(PARROT_IPC.passwordResetConfirm, input),
  },
  // ACCT-SIGNIN-05: main nudges on `onReturn` when `parrot://auth/provider` came back; `takeReturn` hands it over once.
  providerSignIn: {
    list: () => ipcRenderer.invoke(PARROT_IPC.providerList),
    start: (provider, clientChallenge) => ipcRenderer.invoke(PARROT_IPC.providerStart, provider, clientChallenge),
    complete: (input) => ipcRenderer.invoke(PARROT_IPC.providerComplete, input),
    takeReturn: () => ipcRenderer.invoke(PARROT_IPC.providerTakeReturn),
    onReturn: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(PARROT_IPC.providerReturnEvent, handler);
      return () => ipcRenderer.off(PARROT_IPC.providerReturnEvent, handler);
    },
  },
  firstTourOff: process.env.SF_FIRST_TOUR === "off",
  profileSetupOff: process.env.SF_PROFILE_SETUP === "off",
  pairing: {
    start: (options) => ipcRenderer.invoke(PARROT_IPC.pairingStart, options),
    poll: (requestId) => ipcRenderer.invoke(PARROT_IPC.pairingPoll, requestId),
    cancel: () => ipcRenderer.invoke(PARROT_IPC.pairingCancel),
  },
  sibling: {
    offer: () => ipcRenderer.invoke(SIBLING_IPC.offer),
    signIn: () => ipcRenderer.invoke(SIBLING_IPC.signIn),
    cancel: () => ipcRenderer.invoke(SIBLING_IPC.cancel),
  },
  signOut: () => ipcRenderer.invoke(PARROT_IPC.signOut),
  setLibraryKey: (keyBase64) => ipcRenderer.invoke(PARROT_IPC.setLibraryKey, keyBase64),
  createLibraryKey: () => ipcRenderer.invoke(PARROT_IPC.createLibraryKey),
  eraseLibrary: (password, twoFactorCode) => ipcRenderer.invoke(PARROT_IPC.eraseLibrary, password, twoFactorCode),
  keyChange: {
    readiness: () => ipcRenderer.invoke(PARROT_IPC.keyChangeReadiness),
    open: () => ipcRenderer.invoke(PARROT_IPC.keyChangeOpen),
    submit: (password, twoFactorCode) => ipcRenderer.invoke(PARROT_IPC.keyChangeSubmit, password, twoFactorCode),
    switchNow: () => ipcRenderer.invoke(PARROT_IPC.keyChangeSwitchNow),
    poll: () => ipcRenderer.invoke(PARROT_IPC.keyChangePoll),
    stop: () => ipcRenderer.invoke(PARROT_IPC.keyChangeStop),
    pause: () => ipcRenderer.invoke(PARROT_IPC.keyChangePause),
    unreadableFiles: () => ipcRenderer.invoke(PARROT_IPC.keyChangeUnreadableFiles),
    deleteUnreadableFiles: (files) => ipcRenderer.invoke(PARROT_IPC.keyChangeDeleteUnreadableFiles, files),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: KeyChangeState) => listener(state);
      ipcRenderer.on(PARROT_IPC.keyChangeStateEvent, handler);
      return () => ipcRenderer.off(PARROT_IPC.keyChangeStateEvent, handler);
    },
  },
  pickFolders: () => ipcRenderer.invoke(PARROT_IPC.pickFolders),
  pickFiles: () => ipcRenderer.invoke(PARROT_IPC.pickFiles),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  scanImport: (folders) => ipcRenderer.invoke(PARROT_IPC.scanImport, folders),
  getImportScan: () => ipcRenderer.invoke(PARROT_IPC.getImportScan),
  matchImportAlbum: (question) => ipcRenderer.invoke(PARROT_IPC.matchImportAlbum, question),
  stopImportAlbumMatch: (id) => ipcRenderer.invoke(PARROT_IPC.stopImportAlbumMatch, id),
  searchImportAlbums: (question) => ipcRenderer.invoke(PARROT_IPC.searchImportAlbums, question),
  importAlbumPictures: (files) => ipcRenderer.invoke(PARROT_IPC.importAlbumPictures, files),
  pickImportCoverImage: () => ipcRenderer.invoke(PARROT_IPC.pickImportCoverImage),
  onCoverCut: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ParrotCoverCutRequest) => listener(request);
    ipcRenderer.on(PARROT_IPC.coverCutEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.coverCutEvent, handler);
  },
  coverCut: (id, bytes) => ipcRenderer.invoke(PARROT_IPC.coverCut, id, bytes),
  importArtistPhoto: (artistId) => ipcRenderer.invoke(PARROT_IPC.importArtistPhoto, artistId),
  importCover: (albumId) => ipcRenderer.invoke(PARROT_IPC.importCover, albumId),
  confirmImport: (selection) => ipcRenderer.invoke(PARROT_IPC.confirmImport, selection),
  cancelImport: () => ipcRenderer.invoke(PARROT_IPC.cancelImport),
  getImportStatus: () => ipcRenderer.invoke(PARROT_IPC.getImportStatus),
  onImportStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ParrotImportStatus) => listener(status);
    ipcRenderer.on(PARROT_IPC.importStatusEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.importStatusEvent, handler);
  },
  getImportJobs: () => ipcRenderer.invoke(PARROT_IPC.getImportJobs),
  onImportJobs: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, jobs: ParrotImportJob[]) => listener(jobs);
    ipcRenderer.on(PARROT_IPC.importJobsEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.importJobsEvent, handler);
  },
  dismissImportJob: (id) => ipcRenderer.invoke(PARROT_IPC.dismissImportJob, id),
  retryImportJob: (id) => ipcRenderer.invoke(PARROT_IPC.retryImportJob, id),
  retryImportSong: (jobId) => ipcRenderer.invoke(PARROT_IPC.retryImportSong, jobId),
  cancelImportSong: (jobId) => ipcRenderer.invoke(PARROT_IPC.cancelImportSong, jobId),
  getUploadsWhilePlaying: () => ipcRenderer.invoke(PARROT_IPC.getUploadsWhilePlaying),
  setUploadsWhilePlaying: (mode) => ipcRenderer.invoke(PARROT_IPC.setUploadsWhilePlaying, mode),
  playbackActive: (active) => ipcRenderer.send(PARROT_IPC.playbackActive, active),
  findImportJobFolder: (id) => ipcRenderer.invoke(PARROT_IPC.findImportJobFolder, id),
  previewExport: () => ipcRenderer.invoke(PARROT_IPC.previewExport),
  exportMusic: () => ipcRenderer.invoke(PARROT_IPC.exportMusic),
  getExportJobs: () => ipcRenderer.invoke(PARROT_IPC.getExportJobs),
  onExportJobs: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, jobs: ParrotExportJob[]) => listener(jobs);
    ipcRenderer.on(PARROT_IPC.exportJobsEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.exportJobsEvent, handler);
  },
  cancelExport: (id) => ipcRenderer.invoke(PARROT_IPC.cancelExport, id),
  dismissExportJob: (id) => ipcRenderer.invoke(PARROT_IPC.dismissExportJob, id),
  getBackgroundWork: () => ipcRenderer.invoke(PARROT_IPC.getBackgroundWork),
  onBackgroundWork: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, work: ParrotBackgroundWork[]) => listener(work);
    ipcRenderer.on(PARROT_IPC.backgroundWorkEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.backgroundWorkEvent, handler);
  },
  getLibrary: (refresh) => ipcRenderer.invoke(PARROT_IPC.getLibrary, refresh),
  getLyrics: (trackId) => ipcRenderer.invoke(PARROT_IPC.getLyrics, trackId),
  onLyricsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(PARROT_IPC.lyricsChangedEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.lyricsChangedEvent, handler);
  },
  onLibraryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(PARROT_IPC.libraryChangedEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.libraryChangedEvent, handler);
  },
  onLibraryPatch: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, patch: ParrotLibraryPatch) => listener(patch);
    ipcRenderer.on(PARROT_IPC.libraryPatchEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.libraryPatchEvent, handler);
  },
  getCoversWaiting: () => ipcRenderer.invoke(PARROT_IPC.getCoversWaiting),
  onCoversWaiting: (listener) => {
    const handler = (_event: unknown, albumIds: string[]) => listener(albumIds);
    ipcRenderer.on(PARROT_IPC.coversWaitingEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.coversWaitingEvent, handler);
  },
  editPlaylists: (edits) => ipcRenderer.invoke(PARROT_IPC.editPlaylists, edits),
  previewDelete: (target) => ipcRenderer.invoke(PARROT_IPC.previewDelete, target),
  deleteFromLibrary: (target) => ipcRenderer.invoke(PARROT_IPC.deleteFromLibrary, target),
  getEditValues: (target) => ipcRenderer.invoke(PARROT_IPC.getEditValues, target),
  getArtistEditValues: (artistId) => ipcRenderer.invoke(PARROT_IPC.getArtistEditValues, artistId),
  editDetails: (target, cover) => ipcRenderer.invoke(PARROT_IPC.editDetails, target, cover),
  fetchLyrics: (trackId) => ipcRenderer.invoke(PARROT_IPC.fetchLyrics, trackId),
  wantLyrics: (trackId) => ipcRenderer.invoke(PARROT_IPC.wantLyrics, trackId),
  saveLoudness: (measured) => ipcRenderer.invoke(PARROT_IPC.saveLoudness, measured),
  suggestEdit: (query) => ipcRenderer.invoke(PARROT_IPC.suggestEdit, query),
  suggestEditCover: (coverId) => ipcRenderer.invoke(PARROT_IPC.suggestEditCover, coverId),
  playbackUrl: (fileId) => ipcRenderer.invoke(PARROT_IPC.playbackUrl, fileId),
  measureUrl: (fileId) => ipcRenderer.invoke(PARROT_IPC.measureUrl, fileId),
  streamAcquire: (trackId) => ipcRenderer.invoke(PARROT_IPC.streamAcquire, trackId),
  noteScreen: () => ipcRenderer.invoke(PARROT_IPC.noteScreen),
  streamAnswer: (answer) => ipcRenderer.invoke(PARROT_IPC.streamAnswer, answer),
  streamDismiss: () => ipcRenderer.invoke(PARROT_IPC.streamDismiss),
  streamRelease: () => ipcRenderer.invoke(PARROT_IPC.streamRelease),
  getStreamState: () => ipcRenderer.invoke(PARROT_IPC.getStreamState),
  onStreamState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: StreamSlotGateState) => listener(state);
    ipcRenderer.on(PARROT_IPC.streamStateEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.streamStateEvent, handler);
  },
  sendFeedback: (input) => ipcRenderer.invoke(PARROT_IPC.sendFeedback, input),
  lookupPairing: (code) => ipcRenderer.invoke(PARROT_IPC.lookupPairing, code),
  approvePairing: (requestId, proof) => ipcRenderer.invoke(PARROT_IPC.approvePairing, requestId, proof),
  denyPairing: (requestId) => ipcRenderer.invoke(PARROT_IPC.denyPairing, requestId),
  errorReports: createErrorReportsBridge(ipcRenderer),
  updater: createUpdaterBridge(ipcRenderer),
  getAppUpdateRequired: () => ipcRenderer.invoke(PARROT_IPC.getAppUpdateRequired),
  onAppUpdateRequired: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppUpdateRequiredPayload) => listener(payload);
    ipcRenderer.on(PARROT_IPC.appUpdateRequiredEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.appUpdateRequiredEvent, handler);
  },
  storageUnitBase: readStorageUnitBase(ipcRenderer),
  sourceCredits: (product, language) => ipcRenderer.invoke(PARROT_IPC.sourceCredits, product, language),
  getSubscription: () => ipcRenderer.invoke(PARROT_IPC.getSubscription),
  getAccountAccess: () => ipcRenderer.invoke(PARROT_IPC.getAccountAccess),
  listAccountNotices: () => ipcRenderer.invoke(PARROT_IPC.listAccountNotices),
  getBillingStatus: () => ipcRenderer.invoke(PARROT_IPC.getBillingStatus),
  updateSubscription: (plan, options) => ipcRenderer.invoke(PARROT_IPC.updateSubscription, plan, options),
  startCheckout: (input) => ipcRenderer.invoke(PARROT_IPC.startCheckout, input),
  completePayment: (paymentId) => ipcRenderer.invoke(PARROT_IPC.completePayment, paymentId),
  listProfiles: () => ipcRenderer.invoke(PARROT_IPC.listProfiles),
  createProfile: (body) => ipcRenderer.invoke(PARROT_IPC.createProfile, body),
  updateProfile: (id, body) => ipcRenderer.invoke(PARROT_IPC.updateProfile, id, body),
  deleteProfile: (id) => ipcRenderer.invoke(PARROT_IPC.deleteProfile, id),
  onPaymentReturn: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, paymentId: string) => listener(paymentId);
    ipcRenderer.on(PARROT_IPC.paymentReturnEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.paymentReturnEvent, handler);
  },
  getKept: () => ipcRenderer.invoke(PARROT_IPC.getKept),
  getKeptSizes: () => ipcRenderer.invoke(PARROT_IPC.getKeptSizes),
  keepChoices: (kind, id) => ipcRenderer.invoke(PARROT_IPC.keepChoices, kind, id),
  keep: (kind, id, choice) => ipcRenderer.invoke(PARROT_IPC.keep, kind, id, choice),
  unkeep: (kind, id) => ipcRenderer.invoke(PARROT_IPC.unkeep, kind, id),
  onKept: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: KeptStatus) => listener(status);
    ipcRenderer.on(PARROT_IPC.keptEvent, handler);
    return () => ipcRenderer.off(PARROT_IPC.keptEvent, handler);
  },
};

contextBridge.exposeInMainWorld("parrot", bridge);
