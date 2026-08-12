import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chiefOfStaffSystemPrompt } from '../chief-of-staff';

// T5's whole point: the Chief-of-Staff prompt used to interpolate per-PROBLEM
// memory in the MIDDLE of the template, so the single cached block was rewritten
// every run and never read — paying the 1.25x cache-write premium for nothing.
// These tests pin the invariant that makes caching possible at all.

const TRAINER = '\n\nrun 1: Quant 5.8/10';
const REPUTATION = '\n\nHIVE STANDING — ...';
const RECALL = '\n\nRECALL — past episodes ...';
const GOALS = '\n\nSTANDING GOALS — raise Quant discipline ...';

describe('CoS prompt — cacheability invariant', () => {
  it('the STABLE half is byte-identical when every volatile input changes', () => {
    const a = chiefOfStaffSystemPrompt([], TRAINER, REPUTATION, RECALL, GOALS);
    const b = chiefOfStaffSystemPrompt([], 'totally different', 'other standing', 'other recall', 'other goals');
    assert.equal(a.stable, b.stable, 'stable half must not vary with per-run memory');
  });

  it('the stable half is byte-identical when memory is absent entirely', () => {
    const withMem = chiefOfStaffSystemPrompt([], TRAINER, REPUTATION, RECALL, GOALS);
    const noMem = chiefOfStaffSystemPrompt([]);
    assert.equal(withMem.stable, noMem.stable);
  });

  it('carries the big stable content — library, rules, and output spec', () => {
    const { stable } = chiefOfStaffSystemPrompt([]);
    assert.match(stable, /THE LIBRARY \(select these by id\)/);
    assert.match(stable, /RULES:/);
    assert.match(stable, /OUTPUT — respond with ONLY a valid JSON object/);
  });

  it('leaks NO volatile content into the stable half', () => {
    const { stable } = chiefOfStaffSystemPrompt([], TRAINER, REPUTATION, RECALL, GOALS);
    for (const v of [TRAINER.trim(), REPUTATION.trim(), RECALL.trim(), GOALS.trim()]) {
      assert.ok(!stable.includes(v), `stable half leaked volatile content: ${v.slice(0, 30)}`);
    }
  });

  it('puts every volatile block in the volatile half', () => {
    const { volatile } = chiefOfStaffSystemPrompt([], TRAINER, REPUTATION, RECALL, GOALS);
    assert.match(volatile, /Quant 5\.8\/10/);
    assert.match(volatile, /HIVE STANDING/);
    assert.match(volatile, /RECALL — past episodes/);
    assert.match(volatile, /STANDING GOALS/);
  });

  it('volatile is empty when the hive has no memory yet — nothing to append', () => {
    assert.equal(chiefOfStaffSystemPrompt([]).volatile, '');
  });

  it('orders the tail least- to most-volatile: goals, trainer, reputation, recall', () => {
    const { volatile } = chiefOfStaffSystemPrompt([], TRAINER, REPUTATION, RECALL, GOALS);
    const iGoals = volatile.indexOf('STANDING GOALS');
    const iTrainer = volatile.indexOf('Quant 5.8/10');
    const iRep = volatile.indexOf('HIVE STANDING');
    const iRecall = volatile.indexOf('RECALL — past episodes');
    assert.ok(iGoals < iTrainer && iTrainer < iRep && iRep < iRecall,
      `bad order: goals=${iGoals} trainer=${iTrainer} rep=${iRep} recall=${iRecall}`);
  });

  it('a founder-added custom agent DOES change the stable half (correctly invalidates)', () => {
    const none = chiefOfStaffSystemPrompt([]);
    const one = chiefOfStaffSystemPrompt([
      { id: 'tax_guy', title: 'Tax Specialist', domain: 'legal', mandate: 'files things' },
    ]);
    assert.notEqual(none.stable, one.stable);
    assert.match(one.stable, /tax_guy/);
  });
});
