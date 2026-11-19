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
 * The model is Anthropic's (`ANTHROPIC_API_KEY`, required; `REDTEAM_MODEL`, default
 * `claude-haiku-5-5`). Only the API server starts (no Vite client): promptfoo calls
 * the OpenAI-compatible inference API with `model: app:<appId>`, which runs the app's
 * full configuration (system prompt, projects, tools).
 *
 *   ANTHROPIC_API_KEY=... node tests/security/redteam/start-target.mjs
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
import { CANARY_PORT, LLM_PORT, SERVER_PORT, SERVER_SECRET_ENV } from '../injection/scenario.mjs';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set: the red team needs a real model.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTENTS_DIR = 'contents-e2e-redteam';
const MODEL = process.env.REDTEAM_MODEL || 'claude-haiku-5-5';

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
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
      url: 'https://api.anthropic.com/v1/messages',
      provider: 'anthropic',
      contextWindow: 200000,
      maxOutputTokens: 4096,
      supportsTools: 'auto',
      enabled: true,
      default: true
    },
    null,
    2
  )}\n`
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

await startCanary({ port: CANARY_PORT, pages: CANARY_PAGES });

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
