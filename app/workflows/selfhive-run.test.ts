import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeWorkflowError } from './selfhive-run';

// Every failure in the hive's history was recorded as the string "workflow
// failed", because an error crossing a durable-step boundary loses its
// prototype and `err instanceof Error` is false. These pin the extraction so a
// real cause survives to the run_error event.

describe('describeWorkflowError', () => {
  it('reads a real Error', () => {
    assert.equal(describeWorkflowError(new Error('boom')), 'boom');
  });

  it('reads a SERIALIZED error — the prototype-less shape a step boundary produces', () => {
    const serialized = { name: 'TypeError', message: 'x is not a function', stack: '...' };
    assert.equal(describeWorkflowError(serialized), 'TypeError: x is not a function');
    assert.equal(serialized instanceof Error, false); // this is the whole problem
  });

  it('omits a redundant "Error:" prefix', () => {
    assert.equal(describeWorkflowError({ name: 'Error', message: 'plain' }), 'plain');
  });

  it('reads a thrown string', () => {
    assert.equal(describeWorkflowError('just a string'), 'just a string');
  });

  it('unwraps a nested .error / .cause', () => {
    assert.equal(describeWorkflowError({ error: new Error('inner') }), 'inner');
    assert.equal(describeWorkflowError({ cause: { message: 'deep' } }), 'deep');
  });

  it('falls back to JSON for an opaque object rather than losing it', () => {
    assert.match(describeWorkflowError({ code: 42 }), /non-Error thrown: \{"code":42\}/);
  });

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => describeWorkflowError(circular));
  });

  it('names the empty-throw case explicitly', () => {
    assert.match(describeWorkflowError(undefined), /nothing thrown/);
    assert.match(describeWorkflowError(null), /nothing thrown/);
  });

  it('truncates so a giant payload cannot bloat the run_error event', () => {
    assert.ok(describeWorkflowError(new Error('x'.repeat(5000))).length <= 500);
  });
});
