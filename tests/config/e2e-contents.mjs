// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The contents directory the end-to-end servers run on (`e2e-server.mjs`, the dev
 * stack, and `subpath-server.mjs`, a production build behind a path prefix): a fresh
 * install seeded the way the server seeds `contents/`, with every rate limit raised,
 * the remote marketplace off and one default model served by a local stub.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STUB_MODEL_ID, startLlmStub } from './e2e-llm-stub.mjs';

const RAISED_LIMIT = 1_000_000;

/**
 * Seed `contentsDir` (relative to `root`) and start the model stub on `llmPort`.
 * `process.env.CONTENTS_DIR` must already name the directory.
 */
export async function prepareE2eContents({ root, contentsDir, llmPort }) {
  const CONTENTS_DIR = contentsDir;
  const LLM_PORT = llmPort;
  // Seed and migrate exactly as a first start does (a pre-copied platform.json
  // would make the migration runner treat the directory as an old installation).
  const { prepareContents } = await import('../../server/startup/bootstrap.js');
  await prepareContents();

  const platformPath = path.resolve(root, CONTENTS_DIR, 'config', 'platform.json');
  const platform = JSON.parse(fs.readFileSync(platformPath, 'utf8'));
  platform.rateLimit = platform.rateLimit || {};
  for (const key of [
    'default',
    'adminApi',
    'publicApi',
    'authApi',
    'oauthApi',
    'oauthTokenApi',
    'inferenceApi'
  ]) {
    platform.rateLimit[key] = { ...platform.rateLimit[key], limit: RAISED_LIMIT };
  }
  fs.writeFileSync(platformPath, `${JSON.stringify(platform, null, 2)}\n`);

  // No remote marketplace: the catalog the page lists must not depend on the
  // network (a fetched catalog of hundreds of items changes what the pages show).
  const registriesPath = path.resolve(root, CONTENTS_DIR, 'config', 'registries.json');
  if (fs.existsSync(registriesPath)) {
    const registries = JSON.parse(fs.readFileSync(registriesPath, 'utf8'));
    for (const registry of registries.registries || []) {
      registry.enabled = false;
      delete registry.lastSynced;
      delete registry.itemCount;
    }
    fs.writeFileSync(registriesPath, `${JSON.stringify(registries, null, 2)}\n`);
  }
  fs.rmSync(path.resolve(root, CONTENTS_DIR, '.registry-cache'), { recursive: true, force: true });

  // One model, the default, served by a local stub (see e2e-llm-stub.mjs): a chat
  // turn runs end to end without a model key or network.
  await startLlmStub(LLM_PORT);
  fs.writeFileSync(
    path.resolve(root, CONTENTS_DIR, 'models', 'e2e-stub.json'),
    `${JSON.stringify(
      {
        id: 'e2e-stub',
        modelId: STUB_MODEL_ID,
        name: { en: 'E2E stub model', de: 'E2E-Stub-Modell' },
        description: {
          en: 'Answers with a fixed sentence.',
          de: 'Antwortet mit einem festen Satz.'
        },
        url: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
        provider: 'local',
        contextWindow: 8000,
        maxOutputTokens: 2000,
        supportsTools: 'none',
        enabled: true,
        default: true
      },
      null,
      2
    )}\n`
  );
}
