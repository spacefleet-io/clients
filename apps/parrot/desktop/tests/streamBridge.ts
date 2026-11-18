import { vi, type Mock } from "vitest";
import type { StreamSlotAnswer, StreamSlotGateState } from "@space/stream-slots";

export type StreamBridgeStub = {
  streamAcquire: Mock<(trackId: string) => Promise<"play" | "cancel">>;
  streamAnswer: Mock<(answer: StreamSlotAnswer) => Promise<void>>;
  streamDismiss: Mock<() => Promise<void>>;
  streamRelease: Mock<() => Promise<void>>;
  getStreamState: Mock<() => Promise<StreamSlotGateState>>;
  onStreamState: Mock<(listener: (state: StreamSlotGateState) => void) => () => void>;
};

/**
 * The window bridge's stream-limit calls (ACCT-STREAM-01..04) for suites about something else: every song gets its
 * place at once and nothing is ever asked. `stream-slot.test.tsx` drives the real flow.
 */
export const streamBridgeStub = (): StreamBridgeStub => ({
  streamAcquire: vi.fn(async (_trackId: string) => "play" as const),
  streamAnswer: vi.fn(async (_answer: StreamSlotAnswer) => undefined),
  streamDismiss: vi.fn(async () => undefined),
  streamRelease: vi.fn(async () => undefined),
  getStreamState: vi.fn(async (): Promise<StreamSlotGateState> => ({ kind: "idle" })),
  onStreamState: vi.fn((_listener: (state: StreamSlotGateState) => void) => () => undefined),
});
