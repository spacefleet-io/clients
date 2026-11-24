import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button, toast } from "@space/ui";
import { ParrotSettingsRow as Row } from "@space/ui/parrot/screens";
import { KeyChangeDialog, type KeyChangeDialogView } from "@space/desktop-shell/components";
import { keyChangeFailureText } from "@space/shared/keyChangeFailure";
import { keyChangeCountText, keyChangeText } from "@space/shared/keyChangeText";
import { KEY_CHANGE_IDLE, KEY_CHANGE_WAIT_POLL_MS, switchNowOpen, type KeyChangeState, type UnreadableFile } from "@space/media-reseal";
import { keyChangeOffered, type KeyRotationReadiness } from "@space/shared/keyChange";
import { libraryKeyWordsText } from "@space/shared/libraryKeyWords";
import { SPACE_APP_NAMES } from "@space/shared/appScope";
import type { ParrotKeyChangeBridge, ParrotKeyChangeResult, ParrotLanguage, ParrotState } from "../../shared/ipc";

type KeyChangeRowProps = {
  language: ParrotLanguage;
  /** After the switch: main kept the new key and signed out; the window shows sign-in. */
  onState: (state: ParrotState) => void;
};

/**
 * Settings › Account's "Replace media library key" (ACCT-KEYCHG-01, Chris 2026-11-23 Q2): the dialog Badger desktop
 * shows too, driving the key change main runs (`createParrotKeyChange`). Offered only once the server says it can be
 * done here (ACCT-KEYCHG-04: `keyChangeOffered("parrot-desktop", …)`); no bridge (a browser preview), no row.
 */
export function KeyChangeRow({ language, onState }: KeyChangeRowProps) {
  const bridge: ParrotKeyChangeBridge | undefined = window.parrot?.keyChange;
  const keyChangeT = keyChangeText(language);
  const [readiness, setReadiness] = useState<KeyRotationReadiness | null>(null);
  const [open, setOpenState] = useState(false);
  const [words, setWords] = useState<string[] | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [method, setMethod] = useState<"email" | "totp" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<KeyChangeState>(KEY_CHANGE_IDLE);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [unreadableOpen, setUnreadableOpen] = useState(false);
  const [unreadableFiles, setUnreadableFiles] = useState<UnreadableFile[] | null>(null);
  const [unreadableBusy, setUnreadableBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.readiness().then((answer) => live && setReadiness(answer), () => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onState((next) => {
      setState(next);
      if (next.phase === "waiting") setNow(Date.now());
      // The run opened: the code was spent on it (codes are single-use) and the switch asks nothing again.
      if (next.phase === "resealing") {
        setCode("");
        setNeedsCode(false);
      }
    });
    // Leaving Settings pauses the re-seal; the copies made stay with the run until it is stopped or finished.
    return () => {
      off();
      void bridge.pause();
    };
  }, [bridge]);

  /** While media is being re-sealed or switched, the dialog closes only through Stop (ACCT-KEYCHG-08). */
  const setOpen = (next: boolean) => {
    if (!next && state.phase !== "form") return;
    setOpenState(next);
  };

  const openDialog = async () => {
    if (!bridge) return;
    setConfirmed(false);
    setPassword("");
    setCode("");
    setNeedsCode(false);
    setMethod(null);
    setError(null);
    setNotice(null);
    setState(KEY_CHANGE_IDLE);
    setStopConfirmOpen(false);
    setUnreadableOpen(false);
    setUnreadableFiles(null);
    setWords(null);
    setOpenState(true);
    const opened = await bridge.open();
    if (!opened.ok) {
      setError(keyChangeFailureText(language, { status: "failed", reason: "other" }, SPACE_APP_NAMES.badger));
      return;
    }
    setWords(opened.words);
    setHasPassword(opened.hasPassword);
  };

  /** A step's answer: the switch shows sign-in, a code request the code field, a refusal its words. */
  const settle = async (result: ParrotKeyChangeResult) => {
    if (result.status === "switched") {
      setOpenState(false);
      onState(await window.parrot.getState());
    } else if (result.status === "codeNeeded") {
      setNeedsCode(true);
      setMethod(result.method);
      setNotice(keyChangeT("codeSent"));
    } else if (result.status === "failed") {
      // PRIV-KEY-06: Badger's library is the one re-encrypted alongside.
      setError(keyChangeFailureText(language, result, SPACE_APP_NAMES.badger));
    }
  };

  const runBusy = async (step: () => Promise<ParrotKeyChangeResult>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await settle(await step());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // STOR-RESEAL-08: a waiting switch asks the run whether the other uploads ended, then switches.
  useEffect(() => {
    if (!bridge || state.phase !== "waiting") return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (busyRef.current) return;
      void bridge.poll().then((result) => {
        // A failed look at the run is tried again on the next tick; only a switch or a refusal is shown.
        if (result.status !== "waiting") void settle(result);
      });
    }, KEY_CHANGE_WAIT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [bridge, state.phase]);

  if (!bridge || !keyChangeOffered("parrot-desktop", readiness)) return null;

  const copyWords = async () => {
    if (!words) return;
    try {
      await navigator.clipboard.writeText(libraryKeyWordsText(words));
      toast.success(keyChangeT("copied"));
    } catch {
      toast.error(keyChangeT("copyFailed"));
    }
  };

  /** Stop (ACCT-KEYCHG-08, confirmed): the copies are deleted and the library stays as it was (STOR-RESEAL-07). */
  const stop = async () => {
    setStopConfirmOpen(false);
    const result = await bridge.stop();
    if (result.status !== "stopped") {
      await settle(result);
      return;
    }
    setOpenState(false);
    toast.info(keyChangeT("reseal.stoppedTitle"), { description: keyChangeT("reseal.stoppedMessage") });
  };

  /** "See the N files" (ACCT-KEYCHG-07): the files the old key could not open. */
  const showUnreadableFiles = async () => {
    setUnreadableOpen(true);
    setUnreadableFiles(null);
    setUnreadableFiles(await bridge.unreadableFiles());
  };

  /** Deletes the unreadable files; they were lost already (STOR-RESEAL-05). */
  const deleteUnreadableFiles = async () => {
    if (!unreadableFiles?.length) return;
    setUnreadableBusy(true);
    try {
      if (await bridge.deleteUnreadableFiles(unreadableFiles)) {
        toast.success(keyChangeT("reseal.unreadableDeletedTitle"), {
          description: keyChangeCountText(language, "reseal.unreadableDeletedMessage", unreadableFiles.length),
        });
        setUnreadableFiles([]);
      } else {
        toast.error(keyChangeT("reseal.unreadableDeleteFailed"));
      }
    } finally {
      setUnreadableBusy(false);
    }
  };

  const view: KeyChangeDialogView = {
    ...state,
    canSwitchNow: switchNowOpen(state.switchNowAt, now),
    switchNow: () => runBusy(() => bridge.switchNow()),
    stopConfirmOpen,
    setStopConfirmOpen,
    stop,
    unreadableOpen,
    setUnreadableOpen,
    unreadableFiles,
    unreadableBusy,
    showUnreadableFiles,
    deleteUnreadableFiles,
  };

  return (
    <>
      <Row title={keyChangeT("entry.title")} body={keyChangeT("entry.body")}>
        <Button variant="outline" onClick={() => void openDialog()} data-testid="settings-key-change">
          <RotateCw className="mr-2 size-4" aria-hidden />
          {keyChangeT("entry.button")}
        </Button>
      </Row>
      <KeyChangeDialog
        language={language}
        app={SPACE_APP_NAMES.parrot}
        open={open}
        onOpenChange={setOpen}
        words={words}
        onCopyWords={copyWords}
        confirmed={confirmed}
        onConfirmedChange={setConfirmed}
        hasPassword={hasPassword}
        password={password}
        onPasswordChange={setPassword}
        needsCode={needsCode}
        code={code}
        onCodeChange={setCode}
        method={method}
        notice={notice}
        error={error}
        busy={busy}
        onSubmit={() => runBusy(() => bridge.submit(password, code || undefined))}
        view={view}
      />
    </>
  );
}
