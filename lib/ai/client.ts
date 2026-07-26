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
