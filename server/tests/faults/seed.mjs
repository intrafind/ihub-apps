// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Seeds the contents directory of a fault stack. The harness runs it as a
 * process of its own (`harness.mjs`, `seedContents`) and waits for it to end:
 * the seed imports the server's start-up code, which reads `CONTENTS_DIR` once,
 * and the harness itself must stay free of server modules so that one test file
 * can start several stacks.
 *
 * The directory gets what every end-to-end run gets (`tests/config/e2e-contents.mjs`:
 * raised rate limits, no remote marketplace, the two stub models), the users and
 * the app with tools of the agents suite, the test tools
 * (`tests/config/test-tools-contents.mjs`), and what the test asked for.
 *
 * Environment:
 * - `CONTENTS_DIR`: the directory, relative to the repository root, named
 *   `contents-e2e*` (anything else is refused).
 * - `FAULTS_SEED`: JSON `{ llmPort, features?, platform?, apps?, workflows? }`.
 *   `features` and `platform` are laid over `config/features.json` and
 *   `config/platform.json`; `apps` are written to `apps/<id>.json`; `workflows`
 *   maps the id of a shipped workflow to fields laid over its file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seedE2eContents, writeStubModels } from '../../../tests/config/e2e-contents.mjs';
import { disposableContentsPath } from '../../../tests/config/e2e-fresh-contents.mjs';
import {
  mergeOverlay,
  seedAgentsApps,
  seedAgentsUsers
} from '../../../tests/config/agents-contents.mjs';
import { seedTestTools } from '../../../tests/config/test-tools-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const contentsDir = process.env.CONTENTS_DIR;
// Refuses anything but a `contents-e2e*` directory inside the repository.
const contentsPath = disposableContentsPath(root, contentsDir || '');
const seed = JSON.parse(process.env.FAULTS_SEED || '{}');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const overlay = (file, patch) => writeJson(file, mergeOverlay(readJson(file), patch));

process.chdir(root);
await seedE2eContents({ root, contentsDir });
writeStubModels({ root, contentsDir, llmPort: seed.llmPort });

const bcrypt = createRequire(path.join(root, 'server', 'package.json'))('bcryptjs');
seedAgentsUsers(contentsPath, { passwordHash: password => bcrypt.hashSync(password, 10) });
seedAgentsApps(contentsPath);
seedTestTools(contentsPath);

if (seed.features) overlay(path.join(contentsPath, 'config', 'features.json'), seed.features);
if (seed.platform) overlay(path.join(contentsPath, 'config', 'platform.json'), seed.platform);
for (const app of seed.apps || []) {
  writeJson(path.join(contentsPath, 'apps', `${path.basename(String(app.id))}.json`), app);
}
for (const [id, patch] of Object.entries(seed.workflows || {})) {
  overlay(path.join(contentsPath, 'workflows', `${path.basename(id)}.json`), patch);
}

// The start-up code may hold timers and file handles; the seed is done.
process.exit(0);
