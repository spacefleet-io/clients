export type ClientReadyStatus = "checking" | "needs_login" | "needs_key" | "ready";

export type ClientReadyDecisionInput = {
  hasUser: boolean;
  keyAcknowledged: boolean;
  libraryLoading: boolean;
  libraryError: string | null;
  isKeyError: boolean;
};

export const resolveClientReadyStatus = (input: ClientReadyDecisionInput): ClientReadyStatus => {
  if (!input.hasUser) {
    return "needs_login";
  }
  if (!input.keyAcknowledged || input.isKeyError) {
    return "needs_key";
  }
  if (input.libraryLoading && !input.libraryError) {
    return "checking";
  }
  return "ready";
};
