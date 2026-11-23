// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Starts the API server (no Vite client) for the cross-user authorization suite
 * (`tests/security/authz/`, `playwright.authz.config.js`).
 *
 * - Recreates its own contents directory (`contents-e2e-authz`) on every run, seeded
 *   like the other e2e servers (`e2e-contents.mjs`: raised rate limits, no remote
 *   marketplace, a default model served by the local stub, so no model key and no
 *   network).
 * - Adds the principals the suite signs in as (`AUTHZ_USERS` in
 *   `tests/security/authz/principals.js`), a restricted group for carol, one app,
 *   model and prompt only the `users` group may use, one app that is not published,
 *   and turns on every feature that registers user-owned resources. Personal apps
 *   (`userApps`) are on, with both group permissions and publishing.
 * - Starts `server/server.js` with `authz-route-dump.mjs` preloaded, which writes the
 *   live route table to `<contents>/.authz-routes.json` for the coverage guard.
 *
 * Environment (defaults in brackets): `AUTHZ_CONTENTS_DIR` [contents-e2e-authz],
 * `AUTHZ_SERVER_PORT` [3301], `AUTHZ_LLM_PORT` [8991], `AUTHZ_ANONYMOUS` [1]: `0`
 * turns anonymous access off.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareE2eContents } from './e2e-contents.mjs';
import { e2eContentsDir, removeDisposableContents } from './e2e-fresh-contents.mjs';
import {
  AUTHZ_USERS,
  RESTRICTED_GROUP,
  SECRET_APP_ID,
  SECRET_MODEL_ID,
  SECRET_PAGE_ID,
  SECRET_PROMPT_ID,
  UNPUBLISHED_APP_ID,
  UNPUBLISHED_APP_MARKER,
  WORKFLOW_ID
} from '../security/authz/principals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENTS_DIR = e2eContentsDir(root, {
  E2E_CONTENTS_DIR: process.env.AUTHZ_CONTENTS_DIR || 'contents-e2e-authz'
});
const SERVER_PORT = Number(process.env.AUTHZ_SERVER_PORT) || 3301;
const LLM_PORT = Number(process.env.AUTHZ_LLM_PORT) || 8991;
const ANONYMOUS = process.env.AUTHZ_ANONYMOUS !== '0';
const contents = (...parts) => path.resolve(root, CONTENTS_DIR, ...parts);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
removeDisposableContents(root, CONTENTS_DIR);
await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

// --- Features: every feature that registers routes or user-owned resources.
const featuresPath = contents('config', 'features.json');
writeJson(featuresPath, {
  ...(fs.existsSync(featuresPath) ? readJson(featuresPath) : {}),
  skills: true,
  workflows: true,
  promptsLibrary: true,
  usageTracking: true,
  projects: true,
  userProjects: true,
  chatPersistence: true,
  chatSharing: true,
  scheduledTasks: true,
  shortLinks: true,
  feedback: true,
  export: true,
  toolsService: true,
  appAsTool: true,
  runLog: true,
  integrations: true,
  userApps: true
});

// --- Platform: anonymous access as requested, local login on.
const platformPath = contents('config', 'platform.json');
const platform = readJson(platformPath);
platform.anonymousAuth = {
  ...platform.anonymousAuth,
  enabled: ANONYMOUS,
  defaultGroups: ['anonymous']
};
platform.localAuth = {
  ...platform.localAuth,
  enabled: true,
  lockout: { ...platform.localAuth?.lockout, enabled: false }
};
// Personal API keys (OAuth client store) and the MCP gateway, so the suite can
// call `/mcp` and `/api/inference/v1` with a key as well as with a session.
platform.oauth = {
  ...platform.oauth,
  enabled: { ...platform.oauth?.enabled, authz: true, clients: true },
  personalKeys: {
    ...platform.oauth?.personalKeys,
    enabled: true,
    allowedGroups: [],
    scopes: [
      'mcp:tools:read',
      'mcp:tools:call',
      'mcp:apps:invoke',
      'mcp:workflows:run',
      'mcp:resources:read'
    ]
  }
};
platform.mcpServer = {
  ...platform.mcpServer,
  enabled: true,
  requireConsent: false,
  a2a: { ...platform.mcpServer?.a2a, enabled: true }
};
platform.chats = {
  ...platform.chats,
  enabled: true,
  sharing: { ...platform.chats?.sharing, enabled: true, allowPublic: true }
};
// Personal apps: owners may publish, so the publish route is reachable for its
// owner and the matrix tests who else it refuses.
platform.userApps = {
  ...platform.userApps,
  sharing: { ...platform.userApps?.sharing, allowPublish: true }
};
writeJson(platformPath, platform);

// --- Groups. Every signed-in user is also in `authenticated`, so that group (and
// `anonymous`, which it inherits) must not grant the secret app, model and prompt;
// only `users` does. Carol is in the restricted group alone.
const allow = (extra = {}) => ({
  apps: ['*'],
  prompts: ['*'],
  models: ['*'],
  workflows: ['*'],
  skills: ['*'],
  integrations: ['*'],
  adminAccess: false,
  scheduledTasks: true,
  projects: true,
  projectSharing: true,
  // Personal apps: every signed-in principal of the suite may build and share
  // them, so a refusal in the matrix is about the app and never about the group.
  userApps: true,
  userAppSharing: true,
  ...extra
});
const PUBLIC_APPS = ['chat'];
const PUBLIC_MODELS = ['e2e-stub'];
const PUBLIC_PROMPTS = [];
// No global skill for carol (and anonymous): the secret skill is one of them.
const PUBLIC_SKILLS = [];
const groupsPath = contents('config', 'groups.json');
const groups = readJson(groupsPath);
groups.groups.anonymous.permissions = {
  ...groups.groups.anonymous.permissions,
  apps: PUBLIC_APPS,
  models: PUBLIC_MODELS,
  prompts: PUBLIC_PROMPTS
};
groups.groups.authenticated.permissions = allow({
  apps: PUBLIC_APPS,
  models: PUBLIC_MODELS,
  prompts: PUBLIC_PROMPTS,
  skills: PUBLIC_SKILLS,
  workflows: []
});
groups.groups.users.permissions = allow();
groups.groups[RESTRICTED_GROUP] = {
  id: RESTRICTED_GROUP,
  name: 'Authz restricted',
  description: 'Cross-user authorization suite: may not use the secret app, model and prompt',
  inherits: ['authenticated'],
  permissions: allow({
    apps: PUBLIC_APPS,
    models: PUBLIC_MODELS,
    prompts: PUBLIC_PROMPTS,
    skills: PUBLIC_SKILLS,
    workflows: []
  }),
  mappings: []
};
writeJson(groupsPath, groups);

// --- Users, hashed the way localAuth.js does (`<userId>:<password>`).
const requireFromServer = createRequire(path.join(root, 'server', 'package.json'));
const bcrypt = requireFromServer('bcryptjs');
const usersPath = contents('config', 'users.json');
const users = readJson(usersPath);
for (const user of Object.values(AUTHZ_USERS)) {
  if (user.username === 'admin') continue; // the seeded default admin
  users.users[user.id] = {
    id: user.id,
    username: user.username,
    email: `${user.username}@authz.example`,
    name: user.username,
    active: true,
    passwordHash: bcrypt.hashSync(`${user.id}:${user.password}`, 4),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    internalGroups: user.groups
  };
}
writeJson(usersPath, users);

// --- The secret app, model and prompt (only the `users` group may use them).
const stubModel = readJson(contents('models', 'e2e-stub.json'));
writeJson(contents('models', `${SECRET_MODEL_ID}.json`), {
  ...stubModel,
  id: SECRET_MODEL_ID,
  name: { en: 'Authz secret model' },
  default: false
});
const chatApp = readJson(contents('apps', 'chat.json'));
writeJson(contents('apps', `${SECRET_APP_ID}.json`), {
  ...chatApp,
  id: SECRET_APP_ID,
  name: { en: 'Authz secret app' },
  description: { en: 'Only the users group may use it.' },
  preferredModel: SECRET_MODEL_ID,
  features: {},
  skills: []
});
// An app that is not published. The `users` group grants every app, so the
// published rule alone keeps alice and bob out; the admin can try it.
writeJson(contents('apps', `${UNPUBLISHED_APP_ID}.json`), {
  ...chatApp,
  id: UNPUBLISHED_APP_ID,
  name: { en: `${UNPUBLISHED_APP_MARKER} name` },
  description: { en: `${UNPUBLISHED_APP_MARKER} description` },
  system: { en: `${UNPUBLISHED_APP_MARKER} instructions` },
  preferredModel: 'e2e-stub',
  features: {},
  skills: [],
  enabled: false
});
// Chat uses the stub, not the seeded default model that needs a key.
writeJson(contents('apps', 'chat.json'), {
  ...chatApp,
  preferredModel: 'e2e-stub',
  features: { ...chatApp.features, magicPrompt: { enabled: false } }
});
writeJson(contents('prompts', `${SECRET_PROMPT_ID}.json`), {
  id: SECRET_PROMPT_ID,
  name: { en: 'Authz secret prompt' },
  description: { en: 'Only the users group may use it.' },
  prompt: { en: 'Secret prompt text' },
  enabled: true
});

// --- A page only the `users` group may read.
fs.writeFileSync(contents('pages', 'en', `${SECRET_PAGE_ID}.md`), '# Members only\n');
const uiPath = contents('config', 'ui.json');
const ui = readJson(uiPath);
ui.pages = {
  ...ui.pages,
  [SECRET_PAGE_ID]: {
    title: { en: 'Authz members page' },
    filePath: { en: `pages/en/${SECRET_PAGE_ID}.md` },
    authRequired: true,
    allowedGroups: ['users']
  }
};
writeJson(uiPath, ui);

// --- A workflow that needs no model: it stops at a human checkpoint, so an
// execution stays open (and leaves a pending interaction) while the suite runs.
// Started by alice.
const humanWorkflow = {
  id: WORKFLOW_ID,
  name: { en: 'Authz checkpoint workflow' },
  description: { en: 'Waits for a human answer.' },
  version: '1.0.0',
  enabled: true,
  config: { maxIterations: 3, allowCycles: false, defaultModelId: 'e2e-stub' },
  allowedGroups: [],
  nodes: [
    {
      id: 'start',
      type: 'start',
      name: { en: 'Start' },
      position: { x: 0, y: 0 },
      config: { inputVariables: [{ name: 'topic', type: 'string', required: false }] }
    },
    {
      id: 'approval',
      type: 'human',
      name: { en: 'Approve' },
      position: { x: 0, y: 100 },
      config: {
        message: { en: 'Approve?' },
        options: [
          { value: 'approve', label: { en: 'Approve' } },
          { value: 'reject', label: { en: 'Reject' } }
        ]
      }
    },
    {
      id: 'end',
      type: 'end',
      name: { en: 'End' },
      position: { x: 0, y: 200 },
      config: { output: 'done' }
    }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'approval' },
    { id: 'e2', source: 'approval', target: 'end' }
  ]
};
writeJson(contents('workflows', `${WORKFLOW_ID}.json`), humanWorkflow);

// --- The server, with the route table dumped for the coverage guard.
const server = spawn(
  process.execPath,
  ['--import', path.join(root, 'tests', 'config', 'authz-route-dump.mjs'), 'server.js'],
  {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      WORKERS: '1',
      PORT: String(SERVER_PORT),
      CONTENTS_DIR,
      AUTHZ_ROUTE_DUMP: contents('.authz-routes.json')
    }
  }
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
