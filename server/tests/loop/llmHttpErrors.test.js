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
import {
  llmErrorToHttpStatus,
  llmErrorToResponseBody,
  sendLLMError,
  isMissingApiKeyError
} from '../../services/loop/llmHttpErrors.js';

/** Minimal Express-like response double. */
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  return res;
}

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

test('llmErrorToResponseBody — shape and details truncation', () => {
  const long = 'x'.repeat(5000);
  const body = llmErrorToResponseBody(
    err(LLM_ERROR_CODES.PROVIDER_ERROR, { provider: 'openai', details: long, status: 500 })
  );
  assert.equal(body.error, 'msg PROVIDER_ERROR');
  assert.equal(body.code, 'PROVIDER_ERROR');
  assert.equal(body.provider, 'openai');
  assert.equal(body.details.length, 2000);

  const bare = llmErrorToResponseBody(
    err(LLM_ERROR_CODES.TIMEOUT, { details: { not: 'a string' } })
  );
  assert.equal(bare.provider, undefined, 'no provider → omitted');
  assert.equal(bare.details, undefined, 'non-string details → omitted');
  assert.deepEqual(JSON.parse(JSON.stringify(bare)), { error: 'msg TIMEOUT', code: 'TIMEOUT' });
});

test('sendLLMError — status, body and Retry-After for rate limits', () => {
  const res = fakeRes();
  sendLLMError(
    res,
    err(LLM_ERROR_CODES.RATE_LIMITED, { status: 429, retryAfterMs: 2500, provider: 'anthropic' })
  );
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '3', 'ms rounded up to whole seconds');
  assert.equal(res.body.code, 'RATE_LIMITED');
  assert.equal(res.body.provider, 'anthropic');

  const noHint = fakeRes();
  sendLLMError(noHint, err(LLM_ERROR_CODES.RATE_LIMITED, { status: 429 }));
  assert.equal(noHint.statusCode, 429);
  assert.equal(noHint.headers['retry-after'], undefined, 'no header without a provider hint');
});

test('sendLLMError — missing API key is a server-side 500, provider rejection a 502', () => {
  const missing = fakeRes();
  sendLLMError(missing, err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'API_KEY_ERROR' }));
  assert.equal(missing.statusCode, 500);
  assert.equal(missing.body.code, 'AUTH_FAILED');

  const rejected = fakeRes();
  sendLLMError(
    rejected,
    err(LLM_ERROR_CODES.AUTH_FAILED, { providerCode: 'AUTH_FAILED', status: 401 })
  );
  assert.equal(rejected.statusCode, 502);
});

test('sendLLMError — defaultStatus override and non-LLMError fallback', () => {
  const res = fakeRes();
  sendLLMError(res, err(LLM_ERROR_CODES.PROVIDER_ERROR), { defaultStatus: 500 });
  assert.equal(res.statusCode, 500);

  const generic = fakeRes();
  sendLLMError(generic, new TypeError('not an llm error'), { context: 'unit test' });
  assert.equal(generic.statusCode, 500);
  assert.deepEqual(generic.body, { error: 'Internal server error' });
});
