// Elastic Workforce — structured leaf output (decision #3). A leaf agent does not
// write prose we later parse; it CALLS a tool whose schema IS the LeafOutput
// contract, with tool_choice forcing exactly that call. The arguments come back
// as guaranteed-shaped JSON in a single request — highest quality (reliable
// structure → ~no retries) at the lowest cost (Haiku, schema rides the cached
// system path). Reducers merge these typed results up the tree, never raw text.

import Anthropic from '@anthropic-ai/sdk';
import type { LeafOutput, Finding, Citation } from './types';
import { MODEL_LEAF, MAX_TOKENS_LEAF } from './config';

// The tool whose input_schema mirrors LeafOutput. Keep the two in sync.
export const LEAF_TOOL: Anthropic.Tool = {
  name: 'submit_findings',
  description:
    'Submit your complete analysis as structured findings. You MUST call this exactly once with your full result — do not write prose outside it.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '1-3 sentence distillation your lead will read.' },
      confidence: { type: 'number', description: 'Overall confidence in your result, 0 to 1.' },
      findings: {
        type: 'array',
        description: 'Your discrete findings.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            evidence: { type: 'string' },
            confidence: { type: 'number', description: '0 to 1' },
          },
          required: ['claim'],
        },
      },
      citations: {
        type: 'array',
        description: 'Sources backing the findings.',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'URL or artifact reference' },
            note: { type: 'string' },
          },
          required: ['source'],
        },
      },
      incomplete: {
        type: 'boolean',
        description: 'True if you could not finish your slice within the output budget.',
      },
      coverageGap: { type: 'string', description: 'What you left uncovered, if incomplete.' },
    },
    required: ['summary', 'confidence', 'findings'],
  },
};

const clamp01 = (n: unknown): number => {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
};

/**
 * Normalize the model's tool input into a guaranteed-valid LeafOutput. Defensive
 * even with forced tool-use: clamp confidences, coerce arrays, drop malformed
 * entries — so one bad field can never poison the reduce step.
 */
export function parseLeafToolInput(input: unknown): LeafOutput {
  const o = (input ?? {}) as Record<string, unknown>;

  const findings: Finding[] = Array.isArray(o.findings)
    ? (o.findings as Record<string, unknown>[])
        .filter((f) => f && typeof f.claim === 'string')
        .map((f) => ({
          claim: String(f.claim),
          evidence: typeof f.evidence === 'string' ? f.evidence : undefined,
          confidence: f.confidence === undefined ? undefined : clamp01(f.confidence),
        }))
    : [];

  const citations: Citation[] = Array.isArray(o.citations)
    ? (o.citations as Record<string, unknown>[])
        .filter((c) => c && typeof c.source === 'string')
        .map((c) => ({
          source: String(c.source),
          note: typeof c.note === 'string' ? c.note : undefined,
        }))
    : [];

  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    confidence: clamp01(o.confidence),
    findings,
    citations,
    incomplete: o.incomplete === true,
    coverageGap: typeof o.coverageGap === 'string' ? o.coverageGap : undefined,
  };
}

export interface LeafRunResult {
  output: LeafOutput;
  inTokens: number;
  outTokens: number;
  stopReason: string | null;
}

/**
 * Run one leaf agent and get structured output back, forcing the submit_findings
 * tool. The Anthropic client is injected (testability + shared config). Note:
 * forced tool-use is exclusive with live web search — search-needing leaves take
 * a multi-turn path added in a later phase.
 */
export async function runLeaf(
  client: Anthropic,
  args: { system: string; user: string; model?: string; maxTokens?: number },
): Promise<LeafRunResult> {
  const msg = await client.messages.create({
    model: args.model ?? MODEL_LEAF,
    max_tokens: args.maxTokens ?? MAX_TOKENS_LEAF,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
    tools: [LEAF_TOOL],
    tool_choice: { type: 'tool', name: LEAF_TOOL.name },
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  const input = block && 'input' in block ? block.input : {};
  return {
    output: parseLeafToolInput(input),
    inTokens: msg.usage?.input_tokens ?? 0,
    outTokens: msg.usage?.output_tokens ?? 0,
    stopReason: msg.stop_reason ?? null,
  };
}
