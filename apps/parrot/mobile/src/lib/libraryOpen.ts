// What a failed library open means for the user: an account without a Parrot library yet, a saved session the server
// rejected (back to sign-in, with a short explanation), or anything else (kept session, Try again).
import { isSessionRejected } from "@space/shared/api";

export type LibraryOpenOutcome = "missing" | "sessionRejected" | "error";

export const libraryOpenOutcome = (error: unknown): LibraryOpenOutcome => {
  if (isSessionRejected(error)) return "sessionRejected";
  if (error instanceof Error && error.message === "LIBRARY_MISSING") return "missing";
  return "error";
};
