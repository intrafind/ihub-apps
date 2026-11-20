// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Preflight of the nightly red team (`.github/workflows/redteam.yml`): proves the setup
 * before the model is asked anything. The signed-in user (`IHUB_TOKEN`, bob) must be
 * recognised by iHub and must be allowed to use every app `promptfooconfig.yaml` calls
 * and the model those apps run on. Without it the inference API answers
 * `404 app_not_found` for an app that exists (it does not tell "missing" from "not
 * yours"), and promptfoo reports a transform error for every test.
 *
 * Talks to the local iHub on the loopback interface only, so no TLS settings apply.
 *
 *   IHUB_TOKEN=<authToken> node tests/security/redteam/check-access.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PORT } from '../injection/scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.IHUB_URL || `http://127.0.0.1:${SERVER_PORT}`;
const token = process.env.IHUB_TOKEN || '';
/** The model start-target.mjs installs and points the seeded apps at. */
const MODEL_ID = 'redteam-model';

/** The apps the tests call: every `app: <id>` var of the config. */
export function appsOfConfig(configText) {
  const ids = [...configText.matchAll(/^\s+app:\s*([a-z0-9._-]+)\s*$/gim)].map(m => m[1]);
  return [...new Set(ids)];
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  const apps = appsOfConfig(fs.readFileSync(path.join(here, 'promptfooconfig.yaml'), 'utf8'));
  if (apps.length === 0) throw new Error('No app found in promptfooconfig.yaml');

  const { status, body } = await getJson(`${base}/api/inference/v1/models`);
  const listed = new Set((body.data || []).map(model => model.id));
  const wanted = [...apps.map(id => `app:${id}`), MODEL_ID];
  const missing = wanted.filter(id => !listed.has(id));
  if (status === 200 && missing.length === 0) {
    console.log(`The user can use ${wanted.join(', ')}.`);
    return;
  }

  // Say why: not recognised at all, or recognised without the permission.
  const auth = await getJson(`${base}/api/auth/status`);
  const user = auth.body?.user;
  const who =
    user && user.id !== 'anonymous'
      ? `signed in as ${user.username || user.id} (groups: ${(user.groups || []).join(', ') || 'none'})`
      : 'NOT recognised: iHub treats the token as anonymous';
  console.error(`::error::The red team user cannot use what the tests call: ${who}.`);
  console.error(`GET /api/inference/v1/models answered ${status}; missing: ${missing.join(', ')}`);
  console.error(`Visible to this user: ${[...listed].join(', ') || 'nothing'}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`::error::Access check failed: ${error.message}`);
    process.exit(1);
  });
}
