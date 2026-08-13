/**
 * Sole module permitted to construct an Anthropic client.
 * Kill switch + metering ride the same chokepoint so neither can be bypassed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { isAIEnabled } from './flags';
import { recordCall } from '@/lib/cost/meter';
import type { CallMeterCtx } from '@/lib/cost/types';

export { isAIEnabled } from './flags';

export class AIDisabledError extends Error {
  readonly code = 'AI_DISABLED' as const;
  constructor(message = 'AI_DISABLED') {
    super(message);
    this.name = 'AIDisabledError';
  }
}

type ClientOpts = { maxRetries?: number; timeout?: number };

let _default: Anthropic | null = null;

function buildClient(opts?: ClientOpts): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: opts?.maxRetries ?? 6,
    timeout: opts?.timeout ?? 120_000,
  });
}

/**
 * Returns a live Anthropic client, or throws AIDisabledError when the kill
 * switch is off. Use for streaming sites; prefer callModel for create().
 */
export function getAnthropic(opts?: ClientOpts): Anthropic {
  if (!isAIEnabled()) throw new AIDisabledError();
  if (!opts) {
    return (_default ??= buildClient());
  }
  return buildClient(opts);
}

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/**
 * Turn an Anthropic SDK failure into one legible line.
 *
 * `agent_calls` stores `ok: false` and nothing else, and every caller of
 * callModel catches into a constant ('model_unavailable', 'AI_DISABLED'). That
 * made a real production outage indistinguishable from a code bug: an expired
 * key, an exhausted credit balance, a 429, and a malformed request all looked
 * identical in the digest, in /reports, and in the logs. Same failure mode as
 * `describeWorkflowError()` — a failure recorded as an uninformative constant
 * is a failure nobody can act on.
 *
 * Status and error TYPE come first because those are what distinguish an
 * operator problem (fix the env var, add credit) from a code problem.
 */
export function describeModelError(e: unknown): string {
  if (e instanceof AIDisabledError) return 'AI_DISABLED (founder kill switch)';
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { type?: string; message?: string } } | undefined;
    const type = body?.error?.type;
    const msg = body?.error?.message ?? e.message;
    return `HTTP ${e.status ?? '?'}${type ? ` ${type}` : ''}: ${msg}`.slice(0, 300);
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  return String(e).slice(0, 300);
}

/**
 * Flag-checked, metered messages.create. Metering cannot be skipped.
 */
export async function callModel(
  ctx: CallMeterCtx,
  params: CreateParams,
  opts?: ClientOpts,
): Promise<Anthropic.Message> {
  const client = getAnthropic(opts);
  const started = Date.now();
  try {
    const res = await client.messages.create(params);
    await recordCall({
      ...ctx,
      model: String(params.model),
      usage: res.usage,
      latencyMs: Date.now() - started,
      ok: true,
    });
    return res;
  } catch (e) {
    if (!(e instanceof AIDisabledError)) {
      // The single chokepoint every model call passes through, so this is the
      // one place a failure is guaranteed to be seen — log the real cause here
      // rather than relying on callers, which all catch into a constant.
      console.warn(
        `[selfhive] model call failed · ${ctx.role}/${ctx.phase ?? '-'} · ${String(params.model)} · ${describeModelError(e)}`,
      );
      await recordCall({
        ...ctx,
        model: String(params.model),
        usage: { input_tokens: 0, output_tokens: 0 },
        latencyMs: Date.now() - started,
        ok: false,
      });
    }
    throw e;
  }
}
