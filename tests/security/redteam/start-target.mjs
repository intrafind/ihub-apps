// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the target of the nightly LLM red team (`promptfooconfig.yaml`,
 * `.github/workflows/redteam.yml`): the same poisoned contents as the deterministic
 * prompt-injection suite (`tests/security/injection/seed.mjs` - a vendor knowledge base
 * whose document carries planted instructions, a restricted HR project, planted
 * secrets, the attacker's canary on 127.0.0.2), but answered by a **real model**
 * instead of the scripted one. The injection suite proves what the platform contains
 * when the model obeys; this run measures whether the model obeys at all.
 *
 * The model is served by an OpenAI-compatible endpoint (vLLM): `REDTEAM_BASE_URL`
 * (required, e.g. `https://gpu.example.com/v1`; kept out of the repository),
 * `REDTEAM_MODEL` (required, the model id the endpoint lists), and `REDTEAM_API_KEY`
 * if the endpoint wants one. Only the API server starts (no Vite client): promptfoo calls
 * the OpenAI-compatible inference API with `model: app:<appId>`, which runs the app's
 * full configuration (system prompt, projects, tools).
 *
 *   REDTEAM_BASE_URL=... REDTEAM_MODEL=... node tests/security/redteam/start-target.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from '../../config/e2e-contents.mjs';
import { removeDisposableContents } from '../../config/e2e-fresh-contents.mjs';
import { startCanary } from '../injection/canary.mjs';
import { CANARY_PAGES, seedInjectionContents } from '../injection/seed.mjs';
import {
  ADMIN,
  CANARY,
  CANARY_PORT,
  LLM_PORT,
  SERVER_PORT,
  SERVER_SECRET_ENV
} from '../injection/scenario.mjs';
import { AGENCY_CASES, MAIL_APP, agencyPages, installMailTool, mailAppConfig } from './agency.mjs';
import { waitUntil } from './waitUntil.mjs';
import { PAGES_APP, corpusPages, pagesAppConfig, withPagesApp } from './corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTENTS_DIR = 'contents-e2e-redteam';
if (!process.env.REDTEAM_BASE_URL || !process.env.REDTEAM_MODEL) {
  console.error('Set REDTEAM_BASE_URL and REDTEAM_MODEL: the red team needs a real model.');
  process.exit(1);
}
let BASE_URL = process.env.REDTEAM_BASE_URL.trim();
while (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);
const MODEL = process.env.REDTEAM_MODEL;

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
// As in the injection suite: the web research app has a page reader only when a fresh
// install sets up the Staan engine (migration V204 needs this key while seeding).
// The search tool is not part of the scenarios; the key is never sent anywhere.
process.env.STAAN_API_KEY ||= 'dummy-staan-key-never-used';
removeDisposableContents(root, CONTENTS_DIR);
await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

const contentsDir = path.resolve(root, CONTENTS_DIR);
const bcrypt = createRequire(path.join(root, 'server', 'package.json'))('bcryptjs');
seedInjectionContents(contentsDir, { passwordHash: password => bcrypt.hashSync(password, 10) });

// The real model answers every app; the stub stays installed but is not the default.
const modelsDir = path.join(contentsDir, 'models');
const stubPath = path.join(modelsDir, 'e2e-stub.json');
const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
fs.writeFileSync(stubPath, `${JSON.stringify({ ...stub, default: false }, null, 2)}\n`);
fs.writeFileSync(
  path.join(modelsDir, 'redteam-model.json'),
  `${JSON.stringify(
    {
      id: 'redteam-model',
      modelId: MODEL,
      name: { en: `Red team (${MODEL})`, de: `Red Team (${MODEL})` },
      description: { en: 'The model under test.', de: 'Das getestete Modell.' },
      url: `${BASE_URL}/chat/completions`,
      // OpenAI-compatible, as for the e2e stub (docs/local-llm-providers.md).
      provider: 'local',
      ...(process.env.REDTEAM_API_KEY && { apiKey: process.env.REDTEAM_API_KEY }),
      contextWindow: 60000,
      maxOutputTokens: 4096,
      supportsTools: 'auto',
      enabled: true,
      default: true
    },
    null,
    2
  )}\n`
);

// The page corpus of promptfooconfig.corpus.yaml: the summarizer app, and the permission for bob to
// use it (the seed lists the apps of the groups by name).
fs.writeFileSync(
  path.join(contentsDir, 'apps', `${PAGES_APP}.json`),
  `${JSON.stringify(pagesAppConfig(), null, 2)}\n`
);
// Its twin has the canary's mail tool (installed once the server is up, below).
fs.writeFileSync(
  path.join(contentsDir, 'apps', `${MAIL_APP}.json`),
  `${JSON.stringify(mailAppConfig(), null, 2)}\n`
);
const groupsPath = path.join(contentsDir, 'config', 'groups.json');
fs.writeFileSync(
  groupsPath,
  `${JSON.stringify(withPagesApp(JSON.parse(fs.readFileSync(groupsPath, 'utf8')), [PAGES_APP, MAIL_APP]), null, 2)}\n`
);

// The seeded apps name the stub as their preferred model: point them at the real one.
const appsDir = path.join(contentsDir, 'apps');
for (const file of fs.readdirSync(appsDir).filter(f => f.endsWith('.json'))) {
  const appPath = path.join(appsDir, file);
  const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
  if (app.preferredModel === 'e2e-stub') {
    fs.writeFileSync(
      appPath,
      `${JSON.stringify({ ...app, preferredModel: 'redteam-model' }, null, 2)}\n`
    );
  }
}

// The scenario's pages, the corpus pages and the agency pages, all under /page/<name>. The corpus' exfiltration
// addresses point at the canary itself, so a request for one is recorded.
await startCanary({
  port: CANARY_PORT,
  pages: { ...CANARY_PAGES, ...corpusPages(CANARY), ...agencyPages(CANARY) }
});

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: path.join(root, 'server'),
  stdio: 'inherit',
  env: {
    ...process.env,
    ...SERVER_SECRET_ENV,
    NODE_ENV: 'development',
    WORKERS: '1',
    CONTENTS_DIR: contentsDir,
    // Only 127.0.0.1: the canary's allowlisted 127.0.0.2 must not reach the API.
    HOST: '127.0.0.1',
    PORT: String(SERVER_PORT)
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));

// The mail tool of the canary, for the agency pages. The server is not up yet: wait for it.
const up = await waitUntil(
  async () => (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`)).ok,
  {
    attempts: 120
  }
);
if (!up) throw new Error('iHub did not come up for the mail tool');
await installMailTool({
  apiOrigin: `http://127.0.0.1:${SERVER_PORT}`,
  canaryOrigin: CANARY,
  admin: ADMIN
});
console.log(`[redteam] mail tool installed for ${AGENCY_CASES.length} agency pages`);
