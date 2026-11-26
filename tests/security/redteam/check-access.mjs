// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Preflight of the nightly red team (`.github/workflows/redteam.yml`): proves the setup
 * before the model is asked anything. The signed-in user (`IHUB_TOKEN`, bob) must be
 * recognised by iHub and must be allowed to use every app the promptfoo configs call
 * (`promptfooconfig.yaml`, `promptfooconfig.corpus.yaml`) and the model those apps run on. Without it the inference API answers
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
import { MCP_INSTALLATION, SERVER_PORT } from '../injection/scenario.mjs';
import { MAIL_APP } from './agency.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.IHUB_URL || `http://127.0.0.1:${SERVER_PORT}`;
const token = process.env.IHUB_TOKEN || '';
/** The configs of the run: every app any of them calls must be usable. */
const CONFIGS = ['promptfooconfig.yaml', 'promptfooconfig.corpus.yaml'];
/** The model start-target.mjs installs and points the seeded apps at. */
const MODEL_ID = 'redteam-model';

/**
 * The apps the tests call: every `app: <id>` var of the config, bare or quoted, with an
 * optional trailing comment.
 */
export function appsOfConfig(configText) {
  const ids = [...configText.matchAll(/^\s+app:\s*(['"]?)([\w.-]+)\1\s*(?:#.*)?$/gm)].map(
    m => m[2]
  );
  return [...new Set(ids)];
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // A server that accepts the connection and never answers must not hold the job.
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

/**
 * start-target.mjs installs the canary's mail tool once the server is up, which can be after the
 * health check passed: wait until the user's own view of the installation lists it.
 */
async function waitForMailTool() {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { status, body } = await getJson(`${base}/api/integrations/${MCP_INSTALLATION}`);
    if (status === 200 && (body.actions || []).some(action => action.name === 'send_email')) {
      console.log(`The mail tool (${MCP_INSTALLATION}) is installed.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`The mail tool ${MCP_INSTALLATION} never became usable for the user`);
}

async function main() {
  const apps = [
    ...new Set(
      CONFIGS.flatMap(file => {
        const ids = appsOfConfig(fs.readFileSync(path.join(here, file), 'utf8'));
        if (ids.length === 0) throw new Error(`No app found in ${file}`);
        return ids;
      })
    )
  ];

  const { status, body } = await getJson(`${base}/api/inference/v1/models`);
  const listed = new Set((body.data || []).map(model => model.id));
  // The agency pages (agency.mjs) name their app in the generated tests, not in a config.
  const wanted = [...new Set([...apps, MAIL_APP])].map(id => `app:${id}`).concat(MODEL_ID);
  const missing = wanted.filter(id => !listed.has(id));
  if (status === 200 && missing.length === 0) {
    console.log(`The user can use ${wanted.join(', ')}.`);
    await waitForMailTool();
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
