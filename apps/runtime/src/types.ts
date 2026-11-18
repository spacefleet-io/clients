// Re-export all envelope types from @space/runtime-contracts.
// This keeps existing imports from "./types" working.
export {
  APP_IDS,
  type AppId,
  type RuntimeErrorCode,
  type RuntimeCommandRequest,
  type RuntimeErrorEnvelope,
  type RuntimeCommandResponse,
  type WsClientFrame,
  type RuntimeEventFrame,
} from "@space/runtime-contracts/envelope";

// RuntimeCommandContext is local to the runtime — not part of the client contract.
export type RuntimeCommandContext = {
  backendToken: string | null;
  userId?: string | null;
};
