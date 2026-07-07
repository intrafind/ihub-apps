#!/usr/bin/env node

/**
 * Regression test for the "Unsupported URL scheme: <model-id>" failure.
 *
 * Root cause: the `openai` (and `iassistant-conversation`) adapters implement
 * `createCompletionRequest` as ASYNC — they await model auto-discovery. Call
 * sites that forgot to `await` it (WorkflowLLMHelper, openaiProxy, sessionRoutes,
 * ocrProcessor, utils.simpleCompletion, ToolExecutor follow-up) received a
 * Promise instead of the request object. `request.url` was therefore `undefined`,
 * and `throttledFetch(model.id, undefined)` fell back to using the throttle id
 * (the model id) as the URL — which `httpFetch` rejects with
 * "Unsupported URL scheme: <model-id>" (e.g. "ministral", "local-vllm").
 *
 * Guards pinned here:
 *   1. openai `createCompletionRequest` is thenable; the un-awaited value has no
 *      `.url` (the exact footgun), and awaiting it yields the configured URL.
 *   2. a synchronous adapter (mistral) still yields a usable object after await.
 *   3. `httpFetch`'s scheme error now names the offending URL (so a future
 *      regression is self-diagnosing instead of showing only the bare scheme).
 *   4. `redactUrlSecrets` masks query-string secrets and basic-auth userinfo.
 *
 * Run directly: `node server/tests/completion-request-await.test.js`.
 */

import { createCompletionRequest } from '../adapters/index.js';
import { httpFetch, redactUrlSecrets } from '../utils/httpConfig.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const messages = [{ role: 'user', content: 'hi' }];

console.log('🧪 createCompletionRequest await contract\n');

// 1. openai adapter is async — callers MUST await it.
{
  const model = {
    id: 'ministral',
    modelId: 'mistralai/Ministral-3-14B-Instruct-2512',
    provider: 'openai',
    url: 'http://vllm.intrafind.bmg.local/ministral/v1/chat/completions',
    autoDiscovery: false // keep the test offline (no /v1/models discovery fetch)
  };
  const pending = createCompletionRequest(model, messages, 'sk-test', { stream: true });
  check(
    'openai createCompletionRequest returns a thenable',
    pending && typeof pending.then === 'function'
  );
  check(
    'un-awaited openai result has no .url (the footgun that caused the bug)',
    pending.url === undefined
  );
  const request = await pending;
  check(
    'awaited openai request carries the configured url',
    request.url === model.url,
    `url=${request.url}`
  );
}

// 2. a synchronous adapter (mistral) still works when awaited.
{
  const model = {
    id: 'mistral-small',
    modelId: 'mistral-small-latest',
    provider: 'mistral',
    url: 'https://api.mistral.ai/v1/chat/completions'
  };
  const request = await createCompletionRequest(model, messages, 'sk-test', { stream: true });
  check(
    'awaited mistral request carries the configured url',
    request.url === model.url,
    `url=${request.url}`
  );
}

console.log('\n🧪 httpFetch scheme error names the URL\n');

// 3. the scheme error includes the offending URL, not just the scheme.
{
  let msg = '';
  try {
    await httpFetch('ministral');
  } catch (err) {
    msg = err.message;
  }
  check('scheme error identifies the scheme', /"ministral"/.test(msg), msg);
  check('scheme error includes the offending URL', /for URL: ministral/.test(msg), msg);
}

console.log('\n🧪 redactUrlSecrets\n');

// 4. secret redaction for logs / error messages.
{
  check(
    'redacts ?key= query secret',
    redactUrlSecrets('https://host/v1?key=SECRET&z=1') === 'https://host/v1?key=REDACTED&z=1'
  );
  check(
    'redacts access_token query secret',
    redactUrlSecrets('https://host/v1?access_token=abc') === 'https://host/v1?access_token=REDACTED'
  );
  check(
    'redacts basic-auth userinfo',
    redactUrlSecrets('http://user:pass@host/x') === 'http://REDACTED@host/x'
  );
  check(
    'leaves a clean URL untouched',
    redactUrlSecrets('http://host/ministral/v1/chat/completions') ===
      'http://host/ministral/v1/chat/completions'
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
