import { familyFor } from './contracts';
import { verifyNoNewFacts } from './verify';
import { extractFiguresTail, stripFiguresTail } from './source-suffix';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('editor familyFor', () => {
  it('maps financial roles', () => {
    assert.equal(familyFor('financial_advisor'), 'financial');
    assert.equal(familyFor('risk_analyst'), 'financial');
    assert.equal(familyFor('quant_analyst'), 'financial');
  });
  it('maps meta roles', () => {
    assert.equal(familyFor('critic'), 'meta');
    assert.equal(familyFor('trainer'), 'meta');
  });
  it('defaults to research', () => {
    assert.equal(familyFor('researcher'), 'research');
    assert.equal(familyFor('strategist'), 'research');
  });
});

describe('verifyNoNewFacts', () => {
  it('passes when all numbers come from source', () => {
    const r = verifyNoNewFacts('Revenue was $12.5M in 2024', '## NUMBERS\n- $12.5M (2024)');
    assert.equal(r.ok, true);
  });
  it('flags invented numbers', () => {
    const r = verifyNoNewFacts('Revenue was $10M', 'Revenue hit $99M somehow');
    assert.equal(r.ok, false);
    assert.ok(r.inventedNumbers.includes('99') || r.inventedNumbers.some((n) => n.includes('99')));
  });
});

describe('figures tail', () => {
  it('strips the figures block', () => {
    const raw = 'Hello analysis.\n[[FIGURES]]\n{"figures":[]}\n[[/FIGURES]]';
    assert.equal(stripFiguresTail(raw), 'Hello analysis.');
    assert.equal(extractFiguresTail(raw).json, '{"figures":[]}');
  });
});
