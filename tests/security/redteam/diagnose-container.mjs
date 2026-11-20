// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Diagnostic of the nightly red team (`.github/workflows/redteam.yml`): runs the calls
 * promptfoo makes, from where promptfoo makes them. The workflow starts it in
 * promptfoo's own container with the same flags as the eval, next to the same check on
 * the runner, so a difference between the two shows where the token is lost.
 *
 * Prints no secret: the token is only shown as its length and the start of its SHA-256.
 * Informational; it never fails the job. Loopback only.
 *
 *   IHUB_TOKEN=<authToken> node tests/security/redteam/diagnose-container.mjs [label]
 */

import crypto from 'node:crypto';

const base = process.env.IHUB_URL || 'http://127.0.0.1:3401';
const token = process.env.IHUB_TOKEN || '';
const label = process.argv[2] || 'here';
const APP = 'inj-kb';

async function call(method, path, body) {
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000)
    });
    const text = await response.text();
    return { status: response.status, guest: response.headers.has('set-cookie'), text };
  } catch (error) {
    return { status: 0, guest: false, text: `${error.name}: ${error.message}` };
  }
}

const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
console.log(`[${label}] IHUB_TOKEN length ${token.length}, sha256 ${fingerprint}`);

const status = await call('GET', '/api/auth/status');
let user = null;
try {
  user = JSON.parse(status.text).user;
} catch {
  // not JSON: shown below
}
console.log(
  `[${label}] GET /api/auth/status ${status.status}: ` +
    (user && user.id !== 'anonymous'
      ? `signed in as ${user.username || user.id}`
      : 'anonymous (token not recognised)')
);

const models = await call('GET', '/api/inference/v1/models');
let ids = [];
try {
  ids = JSON.parse(models.text).data.map(model => model.id);
} catch {
  // not JSON: shown below
}
console.log(`[${label}] GET /api/inference/v1/models ${models.status}: ${ids.join(', ')}`);

const chat = await call('POST', '/api/inference/v1/chat/completions', {
  model: `app:${APP}`,
  stream: false,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'Reply with one word.' }]
});
console.log(
  `[${label}] POST /api/inference/v1/chat/completions app:${APP} ${chat.status}` +
    `${chat.guest ? ' (a cookie was set)' : ''}: ${chat.text.slice(0, 160).replace(/\s+/g, ' ')}`
);
