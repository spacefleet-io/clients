import type { CommandContract, InferPayload, InferResult } from "@space/runtime-contracts/helpers";
import { runtimeCommandResponseSchema } from "@space/runtime-contracts/envelope";
import { decodeWireBytes, encodeWireBytes } from "@space/runtime-contracts/wireBytes";
import { RuntimeCommandFailedError } from "./errors";
import type { RuntimeFetch } from "./fetch";
import type { RuntimeSessionHandle } from "./session";

export type RuntimeCommandClientConfig = {
  session: RuntimeSessionHandle;
  runtimeBaseUrl: string;
  fetchImpl?: RuntimeFetch;
  requestIdPrefix?: string;
};

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

export const createRuntimeCommandClient = (config: RuntimeCommandClientConfig) => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const runtimeBaseUrl = normalizeUrl(config.runtimeBaseUrl);
  const prefix = config.requestIdPrefix ?? "rc";

  const sendOnce = async <C extends CommandContract>(
    contract: C,
    payload: InferPayload<C>,
    token: string,
  ) => {
    const requestId = `${prefix}-${contract.name}-${crypto.randomUUID()}`;
    const response = await fetchImpl(`${runtimeBaseUrl}/modules/${contract.module}/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        module: contract.module,
        command: contract.name,
        // RT-CMD-05: bytes travel tagged; plain JSON would turn them into an index-keyed object.
        payload: encodeWireBytes(payload),
      }),
    });
    return { response, requestId };
  };

  return {
    async sendCommand<C extends CommandContract>(
      contract: C,
      payload: InferPayload<C>,
    ): Promise<InferResult<C>> {
      // Validate payload before sending
      const payloadCheck = contract.payloadSchema.safeParse(payload);
      if (!payloadCheck.success) {
        const issues = payloadCheck.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("; ");
        throw new RuntimeCommandFailedError({
          message: `Invalid payload for ${contract.name}: ${issues}`,
          code: "invalid_payload",
          retryable: false,
          details: { command: contract.name, validationErrors: issues },
        });
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await config.session.getToken();
        const { response } = await sendOnce(contract, payloadCheck.data as InferPayload<C>, token);

        if (response.status === 401 && attempt === 0) {
          config.session.invalidate();
          continue;
        }

        const rawBody = await response.json().catch(() => null);
        const envelopeParse = runtimeCommandResponseSchema.safeParse(rawBody);

        if (!envelopeParse.success) {
          // Surface enough context to diagnose contract mismatches in prod logs:
          // the first issue path/message + a compact wire-body summary
          // (keys present + types) so we can spot a missing `result`/`error`
          // field or a wrong-type field at a glance instead of bisecting the
          // runtime to find the misshaped responder.
          const firstIssue = envelopeParse.error.issues[0];
          const issueSummary = firstIssue
            ? `${firstIssue.path.length > 0 ? firstIssue.path.join(".") : "(root)"}: ${firstIssue.message}`
            : "unknown";
          const bodySummary =
            rawBody && typeof rawBody === "object"
              ? Object.entries(rawBody as Record<string, unknown>)
                  .map(([k, v]) => `${k}=${v === null ? "null" : typeof v}`)
                  .join(",")
              : `type=${typeof rawBody}`;
          throw new RuntimeCommandFailedError({
            message: `Invalid response envelope from ${contract.name} [${issueSummary}] (wire: ${bodySummary})`,
            code: "invalid_response_envelope",
            retryable: false,
            httpStatus: response.status,
            details: { wireBody: rawBody, issues: envelopeParse.error.issues },
          });
        }

        const envelope = envelopeParse.data;

        if (!envelope.ok) {
          throw new RuntimeCommandFailedError({
            message: envelope.error.message,
            code: envelope.error.code,
            retryable: envelope.error.retryable,
            details: envelope.error.details,
            httpStatus: response.status,
          });
        }

        // Validate result against contract schema
        const resultParse = contract.resultSchema.safeParse(decodeWireBytes(envelope.result));
        if (!resultParse.success) {
          const issues = resultParse.error.issues
            .map((i) =>
              `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
            .join("; ");
          throw new RuntimeCommandFailedError({
            message: `Result schema mismatch for ${contract.name}: ${issues}`,
            code: "invalid_result_schema",
            retryable: false,
            details: { command: contract.name, validationErrors: issues },
          });
        }

        return resultParse.data as InferResult<C>;
      }

      throw new RuntimeCommandFailedError({
        message: `Command ${contract.name} failed after retry`,
        code: "retry_exhausted",
        retryable: false,
      });
    },
  };
};
