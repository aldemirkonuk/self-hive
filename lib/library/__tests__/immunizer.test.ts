// Tests for the HIVE IMMUNE SYSTEM — antibody extraction prompt, the critic-facing
// immune-memory formatter, and (crucially) that it reuses the distiller's parse/filter
// pipeline unchanged. The Haiku extraction itself is exercised by a live probe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { immunizerSystemPrompt, formatAntibodiesForPrompt } from '../immunizer.ts';
import { parseDistillerOutput, filterGeneralizable } from '../distiller.ts';
import type { OverlayRow } from '../../db/overlays.ts';

const ab = (advice: string, pinned = false): OverlayRow => ({
  id: 1, user_id: 'u', agent_id: 'critic', classification: 'x', category: 'EVIDENCE_DISCIPLINE',
  advice_text: advice, source_run_id: 'r', source_score: null, pinned, disabled: false,
  created_at: '2026-01-01', pinned_at: null,
});

test('immunizerSystemPrompt: critic-scoped, generalizable antibody extraction', () => {
  const p = immunizerSystemPrompt();
  assert.match(p, /antibod/i);
  assert.match(p, /"critic"/);
  assert.match(p, /EVIDENCE_DISCIPLINE/);
  assert.match(p, /JSON array/);
  assert.match(p, /NEVER mention specific/i);
});

test('formatAntibodiesForPrompt: empty → ""; non-empty → immune-memory block', () => {
  assert.equal(formatAntibodiesForPrompt([]), '');
  const block = formatAntibodiesForPrompt([ab('Flag unsourced figures.'), ab('Screen overconfident calls.', true)]);
  assert.match(block, /IMMUNE MEMORY/);
  assert.match(block, /Flag unsourced figures\./);
  assert.match(block, /Screen overconfident calls\. \[recurring\]/); // pinned → recurring
});

test('reuse: an immunizer-shaped antibody array parses via the distiller parser', () => {
  const raw = JSON.stringify([
    { agentId: 'critic', category: 'CALIBRATION_DISCIPLINE', adviceText: 'Flag any conclusion stated at high confidence on thin evidence.', sourceScore: null },
    { agentId: 'critic', category: 'NOT_A_CATEGORY', adviceText: 'invalid', sourceScore: null }, // unknown category → dropped
  ]);
  const parsed = parseDistillerOutput(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].category, 'CALIBRATION_DISCIPLINE');
});

test('reuse: filterGeneralizable strips a problem-specific antibody', () => {
  const items = parseDistillerOutput(JSON.stringify([
    { agentId: 'critic', category: 'EVIDENCE_DISCIPLINE', adviceText: 'Flag any claim about Tesla made without a source.', sourceScore: null },
    { agentId: 'critic', category: 'REASONING_DEPTH', adviceText: 'Screen for surface reasoning that skips second-order effects.', sourceScore: null },
  ]));
  const kept = filterGeneralizable(items, 'Should I buy Tesla stock this week?');
  assert.ok(kept.every((k) => !k.adviceText.toLowerCase().includes('tesla')), 'problem-specific antibody dropped');
  assert.ok(kept.some((k) => k.category === 'REASONING_DEPTH'), 'generalizable antibody kept');
});
