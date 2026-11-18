import {
  runtimeCommandRequestSchema,
  wsClientFrameSchema,
} from "@space/runtime-contracts";
import type { RuntimeCommandRequest, RuntimeCommandResponse, RuntimeEventFrame, WsClientFrame } from "./types";

export const parseCommandRequest = (value: unknown): RuntimeCommandRequest | null => {
  const result = runtimeCommandRequestSchema.safeParse(value);
  return result.success ? (result.data as RuntimeCommandRequest) : null;
};

export const parseWsClientFrame = (value: unknown): WsClientFrame | null => {
  const result = wsClientFrameSchema.safeParse(value);
  return result.success ? (result.data as WsClientFrame) : null;
};

// Output validators use structural checks rather than strict zod schemas because
// module responses may include extra fields or use non-record result types
// (arrays, nested objects) that the strict contract schema rejects.
export const isValidCommandResponse = (value: unknown): value is RuntimeCommandResponse => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string") return false;
  if (typeof v.ok !== "boolean") return false;
  // Enforce the two valid wire shapes so malformed responses are never
  // cached or forwarded to clients:
  //   ok=true  → `result` must be present (any value incl. null) and `error` must be null
  //   ok=false → `result` must be null and `error` must be a non-null object
  // Without this, a module returning `result: undefined` (void method) would
  // produce {requestId, ok:true, error:null} on the wire (JSON.stringify strips
  // undefined) which the client-side Zod union rejects.
  if (v.ok === true) {
    if (!("result" in v)) return false;  // result key must be present (null is OK, undefined is not)
    if (v.error !== null) return false;
  } else {
    if (v.result !== null) return false;
    if (!v.error || typeof v.error !== "object") return false;
  }
  return true;
};

export const isValidWsServerFrame = (value: unknown): value is RuntimeEventFrame => {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventId === "string" &&
    typeof v.sequence === "number" &&
    typeof v.app === "string" &&
    typeof v.channel === "string" &&
    typeof v.event === "string" &&
    typeof v.ts === "string" &&
    v.payload !== undefined &&
    typeof v.payload === "object"
  );
};
