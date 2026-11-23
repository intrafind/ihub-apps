// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the agents end-to-end suite adds to the standard e2e contents
 * (`e2e-contents.mjs`): its two users, its app with tools, and the config overlay
 * a run or a restart asks for. The fault harness seeds the same users and app
 * (`server/tests/faults/seed.mjs`). No side effects on import; `agents-server.mjs` calls it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_APP, MODELS, OTHER, TOOLS_APP, USER } from './agents-scenario.mjs';
import { TEST_TOOLS_INSTALLATION } from './test-tools-contents.mjs';

/** The config files an overlay may change: `config/<name>.json`. */
export const OVERLAY_FILES = ['platform', 'features'];

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * `base` with `patch` laid over it: objects are merged key by key, every other
 * value (arrays too) replaces the one below. Neither argument is changed.
 *
 * @param {*} base
 * @param {*} patch
 * @returns {*}
 *
 * @example
 * mergeOverlay({ runs: { a: 1, b: 2 } }, { runs: { b: 3 } }); // { runs: { a: 1, b: 3 } }
 */
export function mergeOverlay(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const merged = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) merged[key] = mergeOverlay(merged[key], value);
  return merged;
}

/**
 * The overlay of an environment variable or a request body, checked.
 *
 * @param {string|Object|undefined|null} input - JSON text or an object; empty means none
 * @returns {Object} `{}` or `{ platform?, features? }`
 * @throws {Error} When it is not an object of objects, or names another file
 */
export function parseOverlay(input) {
  if (input === undefined || input === null || input === '') return {};
  const overlay = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isPlainObject(overlay)) throw new Error('The overlay must be a JSON object.');
  for (const [name, value] of Object.entries(overlay)) {
    if (!OVERLAY_FILES.includes(name)) {
      throw new Error(`The overlay may change ${OVERLAY_FILES.join(' and ')}, not "${name}".`);
    }
    if (!isPlainObject(value)) throw new Error(`The overlay of "${name}" must be a JSON object.`);
  }
  return overlay;
}

const configPath = (contentsDir, name) => path.join(contentsDir, 'config', `${name}.json`);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * The overlay files as they are on disk now: the state every overlay is laid over.
 *
 * @param {string} contentsDir - Absolute path
 * @returns {Record<string, Object>}
 */
export function readBaseline(contentsDir) {
  return Object.fromEntries(
    OVERLAY_FILES.map(name => [name, readJson(configPath(contentsDir, name))])
  );
}

/**
 * Write the overlay files as baseline plus overlay. A file the overlay does not
 * name goes back to its baseline, so one overlay never leaks into the next.
 *
 * @param {string} contentsDir - Absolute path
 * @param {Record<string, Object>} baseline - From {@link readBaseline}
 * @param {Object} overlay - From {@link parseOverlay}
 * @returns {void}
 */
export function writeOverlay(contentsDir, baseline, overlay) {
  for (const name of OVERLAY_FILES) {
    writeJson(configPath(contentsDir, name), mergeOverlay(baseline[name], overlay[name]));
  }
}

/**
 * The environment the suite's iHub server is started with: the one of the helper
 * process, as a test server with the test tools, and never with a kill point.
 *
 * `NODE_ENV=test` and `IHUB_TEST_TOOLS=1` register the tools `e2e_counter_write`
 * and `e2e_counter_read`. A kill point (`IHUB_TEST_KILLPOINT`,
 * `server/utils/killPoint.js`) would let the server end itself in the middle of a
 * spec, so every variable of that name is taken out, whatever the caller's
 * environment holds, and the kill point itself is set to the empty text: the
 * server is started with `--env-file-if-exists`, and a value that is set, even
 * an empty one, wins over the file. A server that dies at a chosen place
 * belongs to the fault tests (`server/tests/faults/`).
 *
 * @param {Record<string, string|undefined>} env - Usually `process.env`
 * @param {Object} settings
 * @param {string} settings.contentsDir - Relative to the repository root
 * @param {number} settings.serverPort
 * @param {string} settings.counterUrl - Where the test tools reach the counter
 * @returns {Record<string, string|undefined>}
 */
export function serverEnvironment(env, { contentsDir, serverPort, counterUrl }) {
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('IHUB_TEST_KILLPOINT'))
  );
  return {
    ...inherited,
    NODE_ENV: 'test',
    IHUB_TEST_TOOLS: '1',
    IHUB_TEST_COUNTER_URL: counterUrl,
    IHUB_TEST_KILLPOINT: '',
    WORKERS: '1',
    CONTENTS_DIR: contentsDir,
    HOST: '127.0.0.1',
    PORT: String(serverPort)
  };
}

/**
 * Add the suite's two regular users to `config/users.json`.
 *
 * @param {string} contentsDir - Absolute path
 * @param {{passwordHash: (password: string) => string}} helpers
 * @returns {void}
 */
export function seedAgentsUsers(contentsDir, { passwordHash }) {
  const usersPath = configPath(contentsDir, 'users');
  const users = readJson(usersPath);
  for (const user of [USER, OTHER]) {
    users.users[user.id] = {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      active: true,
      // Local auth hashes `<user id>:<password>` (middleware/localAuth.js).
      passwordHash: passwordHash(`${user.id}:${user.password}`),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      internalGroups: ['users']
    };
  }
  writeJson(usersPath, users);
}

/**
 * Add the suite's apps to `apps/`: the app with tools ({@link TOOLS_APP}) and the
 * same app with an approval before every tool call ({@link APPROVAL_APP}).
 *
 * @param {string} contentsDir - Absolute path
 * @returns {void}
 */
export function seedAgentsApps(contentsDir) {
  const toolsApp = {
    id: TOOLS_APP,
    order: 2,
    name: { en: 'E2E tools', de: 'E2E-Werkzeuge' },
    description: {
      en: 'Chat with iHub tools, for the agents end-to-end suite.',
      de: 'Chat mit iHub-Werkzeugen, für die Agenten-End-to-End-Tests.'
    },
    color: '#0F766E',
    icon: 'chat-bubbles',
    system: {
      en: 'You are a helpful assistant.',
      de: 'Sie sind ein hilfreicher Assistent.'
    },
    preferredModel: MODELS.tools,
    preferredOutputFormat: 'markdown',
    sendChatHistory: true,
    // iHub's own tools, and the counter tools of the test suite (`e2e_counter_write`,
    // `e2e_counter_read`), which exist only in a server started with the test tools.
    integrations: { ihub: {}, [TEST_TOOLS_INSTALLATION]: {} },
    enabled: true
  };
  writeJson(path.join(contentsDir, 'apps', `${TOOLS_APP}.json`), toolsApp);
  writeJson(path.join(contentsDir, 'apps', `${APPROVAL_APP}.json`), {
    ...toolsApp,
    id: APPROVAL_APP,
    order: 3,
    name: { en: 'E2E approval', de: 'E2E-Freigabe' },
    description: {
      en: 'Chat with iHub tools that ask before every call, for the agents end-to-end suite.',
      de: 'Chat mit iHub-Werkzeugen, die vor jedem Aufruf fragen, für die Agenten-End-to-End-Tests.'
    },
    toolApproval: { default: 'always' }
  });
}
