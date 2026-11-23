import { Platform } from "react-native";
import RNFS from "react-native-fs";
// Types only (erased): the picker is required lazily below, so importing this file (the player does, on TV too)
// touches no native module of it.
import type * as DocumentPicker from "@react-native-documents/picker";
import type { DocumentPickerResponse } from "@react-native-documents/picker";

/** Bigger than any subtitle file: read as an unreadable one rather than loaded into memory (a video picked by mistake). */
const MAX_SUBTITLE_FILE_BYTES = 10 * 1024 * 1024;

/**
 * "Add a subtitle file…" on the phone (PLAY-SUBGET-23): the system's document picker, then the picked file's text.
 * Null when the user cancelled. The picker module is loaded here only, lazily and never on TV: it is not linked into
 * the TV builds (its native module is looked up when it is imported).
 */
export const pickSubtitleFile = async (): Promise<{ name: string; content: string } | null> => {
  if (Platform.isTV) throw new Error("pick_subtitle_file.tv");
  const picker = require("@react-native-documents/picker") as typeof DocumentPicker;
  let picked: DocumentPickerResponse | undefined;
  try {
    // .srt and .ass have no reliable MIME type: any file, checked by name and content when stored.
    [picked] = await picker.pick({ type: [picker.types.plainText, picker.types.allFiles], mode: "import" });
  } catch (error) {
    if (picker.isErrorWithCode(error) && error.code === picker.errorCodes.OPERATION_CANCELED) return null;
    throw error;
  }
  if (!picked) return null;
  const name = picked.name ?? "subtitle";
  console.info("pick_subtitle_file.picked", JSON.stringify({ size: picked.size ?? null, type: picked.type ?? null }));
  if (picked.size != null && picked.size > MAX_SUBTITLE_FILE_BYTES) return { name, content: "" };
  const [copy] = await picker.keepLocalCopy({ files: [{ uri: picked.uri, fileName: name }], destination: "cachesDirectory" });
  if (!copy || copy.status !== "success") throw new Error(`pick_subtitle_file.copy_failed: ${copy?.status === "error" ? copy.copyError : "none"}`);
  const path = decodeURIComponent(copy.localUri.replace(/^file:\/\//, ""));
  try {
    return { name, content: await RNFS.readFile(path, "utf8") };
  } finally {
    void RNFS.unlink(path).catch(() => undefined);
  }
};
