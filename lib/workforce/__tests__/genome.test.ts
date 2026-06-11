// Tests for the HIVE GENOME's pure brain — challenger planning, the mutation prompt,
// and the evolutionary duel rule. (breedChallenger's LLM call is exercised by a live
// probe, not here; importing the module must not need an API key — hence lazy client.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planChallenger,
  mutateGenomePrompt,
  evolveDecision,
  MUTATION_GENES,
  GENOME,
} from '../genome.ts';

test('planChallenger: directed by the parent’s weakest trainer dimension', () => {
  const p = planChallenger({ title: 'Quant Analyst', weakestDimension: 'evidence' });
  assert.equal(p.gene.id, 'rigor'); // weak evidence → amplify rigor
  const c = planChallenger({ title: 'Risk Analyst', weakestDimension: 'calibration' });
  assert.equal(c.gene.id, 'skeptic');
});

test('planChallenger: undirected breeds are deterministic per title (explores genes)', () => {
  const a = planChallenger({ title: 'Macro Strategist' });
  const b = planChallenger({ title: 'Macro Strategist' });
  assert.equal(a.gene.id, b.gene.id, 'same title → same gene (stable)');
});

test('challenger title is distinct and avoids the reputation lane-separator', () => {
  const p = planChallenger({ title: 'Quant Analyst', weakestDimension: 'evidence' });
  assert.notEqual(p.title, 'Quant Analyst');
  assert.ok(p.title.startsWith('Quant Analyst'));
  assert.ok(!p.title.includes(' — '), 'must not use " — " (reputation strips it → would merge standings)');
});

test('mutateGenomePrompt embeds the gene directive + parent identity + genome', () => {
  const gene = MUTATION_GENES.find((g) => g.id === 'skeptic')!;
  const prompt = mutateGenomePrompt('Risk Analyst', 'You are a Risk Analyst. Find what breaks.', gene);
  assert.match(prompt, /Risk Analyst/);
  assert.match(prompt, /more skeptical/);
  assert.match(prompt, /Find what breaks/);
  assert.match(prompt, /JSON object/);
});

test('evolveDecision: a challenger must prove itself before the duel resolves', () => {
  assert.equal(
    evolveDecision({ incumbentRep: 8, challengerRep: 9.5, challengerAppearances: GENOME.MIN_DUEL_APPEARANCES - 1 }),
    'keep_competing'
  );
});

test('evolveDecision: challenger wins by clearing the margin, loses by trailing it', () => {
  assert.equal(evolveDecision({ incumbentRep: 8, challengerRep: 8.0 + GENOME.WIN_MARGIN, challengerAppearances: 3 }), 'challenger_wins');
  assert.equal(evolveDecision({ incumbentRep: 8, challengerRep: 8.0 - GENOME.WIN_MARGIN, challengerAppearances: 3 }), 'incumbent_holds');
  assert.equal(evolveDecision({ incumbentRep: 8, challengerRep: 8.2, challengerAppearances: 9 }), 'keep_competing');
});

test('every mutation gene is well-formed', () => {
  assert.ok(MUTATION_GENES.length >= 4);
  for (const g of MUTATION_GENES) {
    assert.ok(g.id && g.trait && g.directive, 'gene has id/trait/directive');
  }
});
