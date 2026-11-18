import { z } from "zod";
import type { AppId, RuntimeCommandRequest } from "./envelope";

export type CommandContract<
  TName extends string = string,
  TPayload extends z.ZodType = z.ZodType,
  TResult extends z.ZodType = z.ZodType,
> = {
  readonly name: TName;
  readonly module: AppId;
  readonly payloadSchema: TPayload;
  readonly resultSchema: TResult;
};

export const defineCommand = <
  TName extends string,
  TPayload extends z.ZodType,
  TResult extends z.ZodType,
>(contract: {
  name: TName;
  module: AppId;
  payloadSchema: TPayload;
  resultSchema: TResult;
}): CommandContract<TName, TPayload, TResult> => Object.freeze(contract);

export type InferPayload<C extends CommandContract> = z.infer<C["payloadSchema"]>;
export type InferResult<C extends CommandContract> = z.infer<C["resultSchema"]>;

const formatZodIssues = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

/**
 * Parse a runtime command request's payload against a command contract.
 * Uses safeParse so handlers can return structured errors instead of throwing.
 */
export const parsePayload = <C extends CommandContract>(
  contract: C,
  request: RuntimeCommandRequest | { payload: Record<string, unknown> },
): { ok: true; data: InferPayload<C> } | { ok: false; error: string } => {
  const result = contract.payloadSchema.safeParse(request.payload);
  if (!result.success) {
    return { ok: false, error: formatZodIssues(result.error.issues) };
  }
  return { ok: true, data: result.data as InferPayload<C> };
};

/**
 * Parse a runtime command response's result against a command contract.
 * Client-side counterpart to parsePayload — validates the server's response
 * matches the expected result schema.
 */
export const parseResult = <C extends CommandContract>(
  contract: C,
  raw: unknown,
): { ok: true; data: InferResult<C> } | { ok: false; error: string } => {
  const result = contract.resultSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: formatZodIssues(result.error.issues) };
  }
  return { ok: true, data: result.data as InferResult<C> };
};
