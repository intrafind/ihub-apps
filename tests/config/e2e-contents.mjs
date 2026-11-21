// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The contents directory the end-to-end servers run on (`e2e-server.mjs`, the dev
 * stack, and `subpath-server.mjs`, a production build behind a path prefix): a fresh
 * install seeded the way the server seeds `contents/`, with every rate limit raised,
 * the remote marketplace off and two models served by a local stub: the default one,
 * and `e2e-stub-tools`, which is offered tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STUB_MODEL_ID, STUB_TOOLS_MODEL_ID, startLlmStub } from './e2e-llm-stub.mjs';

const RAISED_LIMIT = 1_000_000;

/**
 * Seed `contentsDir` (relative to `root`) and start the model stub on `llmPort`.
 * `process.env.CONTENTS_DIR` must already name the directory. `stubOptions` go to
 * `startLlmStub` (a scripted model, see e2e-llm-stub.mjs).
 */
export async function prepareE2eContents({ root, contentsDir, llmPort, stubOptions }) {
  await seedE2eContents({ root, contentsDir });
  // The default model, served by a local stub (see e2e-llm-stub.mjs): a chat turn
  // runs end to end without a model key or network.
  await startLlmStub(llmPort, stubOptions);
  writeStubModels({ root, contentsDir, llmPort });
}

/**
 * Seed `contentsDir` (relative to `root`) as a first start does, and change what an
 * end-to-end run needs changed: raised rate limits, no AI-use acknowledgement, no
 * remote marketplace. Starts nothing. `process.env.CONTENTS_DIR` must already name
 * the directory.
 *
 * The fault harness (`server/tests/faults/seed.mjs`) calls it in a process of its
 * own: its model stub lives in the test process, not in the one that seeds.
 */
export async function seedE2eContents({ root, contentsDir }) {
  const CONTENTS_DIR = contentsDir;
  // Seed and migrate exactly as a first start does (a pre-copied platform.json
  // would make the migration runner treat the directory as an old installation).
  const { prepareContents } = await import('../../server/startup/bootstrap.js');
  await prepareContents();
  if (!fs.existsSync(path.resolve(root, CONTENTS_DIR, 'config', 'platform.json'))) {
    // The server config read CONTENTS_DIR before the caller set it, so the seed went
    // to another directory (the developer's own contents/).
    throw new Error(
      `${CONTENTS_DIR} was not seeded: set process.env.CONTENTS_DIR before importing any server module`
    );
  }

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
  // The AI-use acknowledgement (#3326) is on by default and would block every chat
  // turn of the other specs with a dialog / 428. Only ai-acknowledgement.spec.js
  // turns it on, through the admin platform API.
  platform.aiAcknowledgement = { ...platform.aiAcknowledgement, enabled: false };
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
}

/**
 * Write the two stub models into `models/`: `e2e-stub` (the default, no tools) and
 * `e2e-stub-tools`, both served by the model stub on `llmPort`.
 */
export function writeStubModels({ root, contentsDir, llmPort }) {
  const CONTENTS_DIR = contentsDir;
  const LLM_PORT = llmPort;
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
  // The same stub as a second model that is offered tools (`e2e-tool:` and the other
  // markers of e2e-llm-stub.mjs call them). Not the default: the default model keeps
  // `supportsTools: 'none'`, so the requests of the existing specs carry no tool list.
  fs.writeFileSync(
    path.resolve(root, CONTENTS_DIR, 'models', 'e2e-stub-tools.json'),
    `${JSON.stringify(
      {
        id: 'e2e-stub-tools',
        modelId: STUB_TOOLS_MODEL_ID,
        name: { en: 'E2E stub model with tools', de: 'E2E-Stub-Modell mit Werkzeugen' },
        description: {
          en: 'Calls the tools a test message names.',
          de: 'Ruft die Werkzeuge auf, die eine Testnachricht nennt.'
        },
        url: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
        provider: 'local',
        contextWindow: 64000,
        maxOutputTokens: 2000,
        supportsTools: 'auto',
        enabled: true,
        default: false
      },
      null,
      2
    )}\n`
  );
}
