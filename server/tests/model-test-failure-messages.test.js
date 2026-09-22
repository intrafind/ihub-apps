/**
 * `describeModelTestFailure` (POST /admin/models/:id/test) must always emit a
 * `messageKey` alongside its English `userMessage` — that key is what the
 * admin UI translates (shared/i18n/*.json `admin.models.testResults.messages`)
 * instead of matching on the English headline text (github.com/intrafind/ihub-apps
 * issue #1582: the test result was never translated).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeModelTestFailure } from '../routes/admin/models.js';
import { LLMError, LLM_ERROR_CODES } from '../services/loop/contracts/errors.js';

test('a blackholed connect (UND_ERR_CONNECT_TIMEOUT) maps to connectionTimeout', () => {
  const err = new LLMError('fetch failed', {
    code: LLM_ERROR_CODES.NETWORK,
    providerCode: 'UND_ERR_CONNECT_TIMEOUT'
  });
  const { messageKey, userMessage } = describeModelTestFailure(err);
  assert.equal(messageKey, 'connectionTimeout');
  assert.equal(userMessage, 'Connection timeout');
});

test('ECONNREFUSED maps to connectionRefused', () => {
  const err = new LLMError('fetch failed', {
    code: LLM_ERROR_CODES.NETWORK,
    providerCode: 'ECONNREFUSED'
  });
  assert.equal(describeModelTestFailure(err).messageKey, 'connectionRefused');
});

test('ENOTFOUND maps to serviceNotFound', () => {
  const err = new LLMError('fetch failed', {
    code: LLM_ERROR_CODES.NETWORK,
    providerCode: 'ENOTFOUND'
  });
  assert.equal(describeModelTestFailure(err).messageKey, 'serviceNotFound');
});

test('a NETWORK error with no recognized socket cause maps to networkError', () => {
  const err = new LLMError('boom', { code: LLM_ERROR_CODES.NETWORK });
  assert.equal(describeModelTestFailure(err).messageKey, 'networkError');
});

test('TIMEOUT maps to requestTimeout', () => {
  const err = new LLMError('slow', { code: LLM_ERROR_CODES.TIMEOUT });
  assert.equal(describeModelTestFailure(err).messageKey, 'requestTimeout');
});

test('AUTH_FAILED with a missing API key maps to apiKeyNotConfigured', () => {
  const err = new LLMError('no key', {
    code: LLM_ERROR_CODES.AUTH_FAILED,
    providerCode: 'API_KEY_MISSING'
  });
  assert.equal(describeModelTestFailure(err).messageKey, 'apiKeyNotConfigured');
});

test('AUTH_FAILED with a 403 (key present but rejected) maps to accessDenied', () => {
  const err = new LLMError('forbidden', { code: LLM_ERROR_CODES.AUTH_FAILED, status: 403 });
  assert.equal(describeModelTestFailure(err).messageKey, 'accessDenied');
});

test('AUTH_FAILED otherwise maps to authenticationFailed', () => {
  const err = new LLMError('bad key', { code: LLM_ERROR_CODES.AUTH_FAILED, status: 401 });
  assert.equal(describeModelTestFailure(err).messageKey, 'authenticationFailed');
});

test('MODEL_NOT_FOUND maps to modelNotFound', () => {
  const err = new LLMError('nope', { code: LLM_ERROR_CODES.MODEL_NOT_FOUND });
  assert.equal(describeModelTestFailure(err).messageKey, 'modelNotFound');
});

test('RATE_LIMITED maps to rateLimitExceeded', () => {
  const err = new LLMError('slow down', { code: LLM_ERROR_CODES.RATE_LIMITED });
  assert.equal(describeModelTestFailure(err).messageKey, 'rateLimitExceeded');
});

test('PROVIDER_ERROR with a 5xx status maps to serverError', () => {
  const err = new LLMError('oops', { code: LLM_ERROR_CODES.PROVIDER_ERROR, status: 500 });
  assert.equal(describeModelTestFailure(err).messageKey, 'serverError');
});

test('PROVIDER_ERROR with a non-5xx status falls back to testFailed', () => {
  const err = new LLMError('odd', { code: LLM_ERROR_CODES.PROVIDER_ERROR, status: 400 });
  assert.equal(describeModelTestFailure(err).messageKey, 'testFailed');
});

test('an unmapped code falls back to testFailed', () => {
  const err = new LLMError('???', { code: LLM_ERROR_CODES.INVALID_REQUEST });
  assert.equal(describeModelTestFailure(err).messageKey, 'testFailed');
});

test('every branch returns a non-empty userMessage, errorMessage and messageKey', () => {
  const errors = [
    new LLMError('a', { code: LLM_ERROR_CODES.NETWORK, providerCode: 'UND_ERR_CONNECT_TIMEOUT' }),
    new LLMError('b', { code: LLM_ERROR_CODES.NETWORK, providerCode: 'ECONNREFUSED' }),
    new LLMError('c', { code: LLM_ERROR_CODES.NETWORK, providerCode: 'ENOTFOUND' }),
    new LLMError('d', { code: LLM_ERROR_CODES.NETWORK }),
    new LLMError('e', { code: LLM_ERROR_CODES.TIMEOUT }),
    new LLMError('f', { code: LLM_ERROR_CODES.AUTH_FAILED, providerCode: 'API_KEY_MISSING' }),
    new LLMError('g', { code: LLM_ERROR_CODES.AUTH_FAILED, status: 403 }),
    new LLMError('h', { code: LLM_ERROR_CODES.AUTH_FAILED }),
    new LLMError('i', { code: LLM_ERROR_CODES.MODEL_NOT_FOUND }),
    new LLMError('j', { code: LLM_ERROR_CODES.RATE_LIMITED }),
    new LLMError('k', { code: LLM_ERROR_CODES.PROVIDER_ERROR, status: 500 }),
    new LLMError('l', { code: LLM_ERROR_CODES.PROVIDER_ERROR, status: 400 }),
    new LLMError('m', { code: LLM_ERROR_CODES.INVALID_REQUEST })
  ];
  for (const err of errors) {
    const { userMessage, errorMessage, messageKey } = describeModelTestFailure(err);
    assert.ok(userMessage, `userMessage missing for code=${err.code}`);
    assert.ok(errorMessage, `errorMessage missing for code=${err.code}`);
    assert.ok(messageKey, `messageKey missing for code=${err.code}`);
  }
});
