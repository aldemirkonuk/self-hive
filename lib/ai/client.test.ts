import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AIDisabledError, describeModelError } from './client';

// A model call that fails records `ok: false` and nothing else, and every
// caller catches into a constant. Without this, an expired key, an exhausted
// balance, a 429 and a malformed request are all the same string — which is
// how a real production outage stayed undiagnosable from inside the hive.
describe('describeModelError', () => {
  function apiError(status: number, type: string, message: string) {
    return new Anthropic.APIError(status, { type: 'error', error: { type, message } }, message, undefined);
  }

  it('distinguishes an operator problem from a code problem', () => {
    const credit = describeModelError(apiError(400, 'invalid_request_error', 'Your credit balance is too low'));
    assert.match(credit, /HTTP 400/);
    assert.match(credit, /invalid_request_error/);
    assert.match(credit, /credit balance is too low/);

    const auth = describeModelError(apiError(401, 'authentication_error', 'invalid x-api-key'));
    assert.match(auth, /HTTP 401/);
    assert.match(auth, /invalid x-api-key/);
    assert.notEqual(credit, auth, 'a bad key must not read like an empty balance');
  });

  it('names the kill switch rather than reporting it as a fault', () => {
    assert.match(describeModelError(new AIDisabledError()), /founder kill switch/);
  });

  it('handles plain errors and non-errors without throwing', () => {
    assert.match(describeModelError(new TypeError('fetch failed')), /TypeError: fetch failed/);
    assert.equal(describeModelError('boom'), 'boom');
    assert.equal(typeof describeModelError(undefined), 'string');
  });

  it('bounds the message so a huge API body cannot flood the log or the digest', () => {
    assert.ok(describeModelError(new Error('x'.repeat(5000))).length <= 300);
    assert.ok(describeModelError(apiError(429, 'rate_limit_error', 'y'.repeat(5000))).length <= 300);
  });
});
