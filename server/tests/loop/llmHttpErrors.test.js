// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * llmHttpErrors — mapping of the LLMError taxonomy onto HTTP responses used
 * by the single-shot routes (admin translate/completions/model test, magic
 * prompt, model chat test).
 *
 * Run: node --test server/tests/loop/llmHttpErrors.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMError, LLM_ERROR_CODES } from '../../services/loop/contracts/errors.js';
import { llmErrorToHttpStatus, isMissingApiKeyError } from '../../services/loop/llmHttpErrors.js';

const err = (code, props = {}) => new LLMError(`msg ${code}`, { code, ...props });

test('llmErrorToHttpStatus — code table', () => {
  const cases = [
    [err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'API_KEY_ERROR' }), 500],
    [err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'API_KEY_MISSING' }), 500],
    [err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'AUTH_FAILED', status: 401 }), 502],
    [err(LLM_ERROR_CODES.AUTH_FAILED, { status: 403 }), 502],
    [err(LLM_ERROR_CODES.MODEL_NOT_FOUND), 404],
    [err(LLM_ERROR_CODES.INVALID_REQUEST, { status: 422 }), 400],
    [err(LLM_ERROR_CODES.CONTEXT_WINDOW_EXCEEDED, { status: 400 }), 400],
    [err(LLM_ERROR_CODES.RATE_LIMITED, { status: 429 }), 429],
    [err(LLM_ERROR_CODES.TIMEOUT), 504],
    [err(LLM_ERROR_CODES.NETWORK), 502],
    [err(LLM_ERROR_CODES.ABORTED), 499]
  ];
  for (const [e, expected] of cases) {
    assert.equal(llmErrorToHttpStatus(e), expected, `${e.code}/${e.providerCode}/${e.status}`);
  }
});

test('llmErrorToHttpStatus — PROVIDER_ERROR relays upstream 4xx, hides 5xx, defaults otherwise', () => {
  assert.equal(llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR, { status: 503 })), 502);
  assert.equal(llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR, { status: 500 })), 502);
  assert.equal(llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR, { status: 402 })), 402);
  assert.equal(llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR)), 502, 'no status');
  assert.equal(
    llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR), { defaultStatus: 500 }),
    500,
    'defaultStatus honoured when no upstream status'
  );
  assert.equal(
    llmErrorToHttpStatus(err(LLM_ERROR_CODES.PROVIDER_ERROR, { status: 200 })),
    502,
    'never relays a non-error upstream status'
  );
  assert.equal(
    llmErrorToHttpStatus(err(LLM_ERROR_CODES.EMPTY_RESPONSE)),
    502,
    'unlisted taxonomy codes use the provider-error branch'
  );
});

test('llmErrorToHttpStatus — non-LLMError input is a plain 500', () => {
  assert.equal(llmErrorToHttpStatus(new Error('boom')), 500);
  assert.equal(llmErrorToHttpStatus(null), 500);
  assert.equal(llmErrorToHttpStatus({ code: 'RATE_LIMITED' }), 500, 'needs name LLMError');
});

test('isMissingApiKeyError', () => {
  assert.equal(
    isMissingApiKeyError(err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'API_KEY_ERROR' })),
    true
  );
  assert.equal(
    isMissingApiKeyError(err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'AUTH_FAILED' })),
    false
  );
  assert.equal(
    isMissingApiKeyError(err(LLM_ERROR_CODES.NETWORK, { providerCode: 'API_KEY_ERROR' })),
    false
  );
  assert.equal(isMissingApiKeyError(new Error('x')), false);
});
