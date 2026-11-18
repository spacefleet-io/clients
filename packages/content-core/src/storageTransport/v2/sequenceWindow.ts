export type SequenceApplyResult =
  | { ok: true; status: "accepted" | "duplicate"; expectedSeq: number }
  | { ok: false; status: "out_of_order"; expectedSeq: number };

/**
 * Tracks strict monotonic sequence numbers for one stream.
 * `expectedSeq` starts at 0.
 */
export class SequenceTracker {
  private expectedSeq = 0;

  apply(seq: number): SequenceApplyResult {
    if (!Number.isInteger(seq) || seq < 0) {
      return { ok: false, status: "out_of_order", expectedSeq: this.expectedSeq };
    }
    if (seq < this.expectedSeq) {
      return { ok: true, status: "duplicate", expectedSeq: this.expectedSeq };
    }
    if (seq > this.expectedSeq) {
      return { ok: false, status: "out_of_order", expectedSeq: this.expectedSeq };
    }
    this.expectedSeq += 1;
    return { ok: true, status: "accepted", expectedSeq: this.expectedSeq };
  }

  getExpectedSeq(): number {
    return this.expectedSeq;
  }
}

export type FlowWindowStats = {
  inflight: number;
  available: number;
  maxInFlight: number;
};

/**
 * Simple flow-window controller.
 * Sender consumes capacity when sending frames and releases it on ack.
 */
export class FlowWindow {
  private readonly maxInFlight: number;
  private inflight = 0;

  constructor(maxInFlight = 16) {
    if (!Number.isInteger(maxInFlight) || maxInFlight <= 0) {
      throw new Error("invalid_flow_window_size");
    }
    this.maxInFlight = maxInFlight;
  }

  canSend(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) return false;
    return this.inflight + count <= this.maxInFlight;
  }

  onSend(count = 1): boolean {
    if (!this.canSend(count)) return false;
    this.inflight += count;
    return true;
  }

  onAck(count = 1): void {
    if (!Number.isInteger(count) || count <= 0) return;
    this.inflight = Math.max(0, this.inflight - count);
  }

  getStats(): FlowWindowStats {
    return {
      inflight: this.inflight,
      available: Math.max(0, this.maxInFlight - this.inflight),
      maxInFlight: this.maxInFlight,
    };
  }
}

