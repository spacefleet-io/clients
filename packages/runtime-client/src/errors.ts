export class RuntimeCommandFailedError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number | null;

  constructor(input: {
    message: string;
    code: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    httpStatus?: number | null;
  }) {
    super(input.message);
    this.name = "RuntimeCommandFailedError";
    this.code = input.code;
    this.retryable = Boolean(input.retryable);
    this.details = input.details ?? {};
    this.httpStatus = input.httpStatus ?? null;
  }
}
