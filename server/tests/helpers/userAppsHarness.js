// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test harness for personal apps on the chat path (feature `userApps`): a
 * populated config cache, a filesystem store in a scratch directory, the real
 * routes of the interactive chat on an Express app, and people built by the
 * real `enhanceUserWithPermissions`.
 *
 * The principal of a request comes from the header `x-test-principal`, which
 * names an entry of {@link PEOPLE} (or one a test added with `addPerson`).
 *
 * ```js
 * let harness;
 * before(async () => { harness = await startUserAppsHarness(); });
 * after(() => harness.stop());
 * beforeEach(() => harness.reset());
 *
 * const app = await harness.createApp('anna', { members: [member('ben', 'user')] });
 * const res = await harness.as('ben').get(`/api/apps/${app.id}`);
 * ```
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';

import configCache from '../../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../../storage/bootstrap.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import ChatService from '../../services/chat/ChatService.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import { resolveChatOwner } from '../../services/chat/chatOwner.js';
import { getUserAppRepository } from '../../services/userApps/UserAppRepository.js';
import {
  setCompanyAppStampsChecked,
  userAppOwnerSnapshot
} from '../../services/userApps/userAppAccess.js';
import { resetUserAppRunMemory } from '../../services/userApps/userAppResolution.js';
import { userAppContentSchema } from '../../validators/userAppSchema.js';
import registerGeneralRoutes from '../../routes/generalRoutes.js';
import registerSessionRoutes from '../../routes/chat/sessionRoutes.js';
import registerMagicPromptRoutes from '../../routes/magicPromptRoutes.js';
import registerConversationRoutes from '../../routes/chat/conversationRoutes.js';
import registerFeedbackRoutes from '../../routes/chat/feedbackRoutes.js';
import registerChatRoutes from '../../routes/chats.js';
import scopeRoutes from '../../routes/integrations/scopes.js';
import userIntegrationRoutes from '../../routes/integrations/userIntegrations.js';
import errorHandler from '../../middleware/errorHandler.js';
import { captureRunLog } from '../loop/helpers/llmFixtures.js';

// The workflow routes start the sweep of their event streams when the module
// is imported, on an interval that would keep a test process alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();
const { default: registerWorkflowRoutes } = await import('../../routes/workflow/workflowRoutes.js');
globalThis.setInterval = realSetInterval;

/** A published admin app every group may use. */
export const ADMIN_APP = 'app-company';
/** A published admin app only the group `staff` is granted on an installation without the wildcard. */
export const STAFF_APP = 'app-staff';
/** An ID of the personal shape that nothing has. */
export const UNKNOWN_PERSONAL_ID = 'uap_00000000000000000000000000000000';
/** A text that is only in the instructions of a personal app. */
export const SECRET = 'personal-instructions-marker-7d1e';

export const MODELS = [
  {
    id: 'oa',
    name: { en: 'Stub model' },
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://model.invalid/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true,
    enabled: true
  },
  {
    id: 'restricted',
    name: { en: 'Restricted model' },
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://model.invalid/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    enabled: true
  }
];

const adminApp = (id, extra = {}) => ({
  id,
  name: { en: id },
  description: { en: `${id} description` },
  system: { en: `You are ${id}.` },
  tokenLimit: 4096,
  preferredModel: 'oa',
  enabled: true,
  ...extra
});

export const APPS = [adminApp(ADMIN_APP), adminApp(STAFF_APP)];

const permissions = (extra = {}) => ({
  apps: ['*'],
  models: ['*'],
  prompts: [],
  integrations: ['*'],
  projects: true,
  scheduledTasks: true,
  userApps: true,
  userAppSharing: true,
  ...extra
});

/**
 * The groups of the fixture.
 *
 * @param {Object} [options]
 * @param {boolean} [options.wildcard=true] - Whether `users` holds `apps: ["*"]`.
 *   Without it `users` is granted {@link ADMIN_APP} only, and `staff`
 *   {@link STAFF_APP} too.
 * @returns {Object}
 */
export function groupsWith({ wildcard = true, users = {} } = {}) {
  const apps = wildcard ? ['*'] : [ADMIN_APP];
  return {
    groups: {
      anonymous: {
        id: 'anonymous',
        permissions: permissions({ apps, userApps: false, userAppSharing: false })
      },
      users: { id: 'users', permissions: permissions({ apps, ...users }) },
      staff: {
        id: 'staff',
        permissions: permissions({ apps: wildcard ? ['*'] : [ADMIN_APP, STAFF_APP] })
      },
      // Holds neither of the two personal app permissions.
      guests: {
        id: 'guests',
        permissions: permissions({ apps, userApps: false, userAppSharing: false })
      },
      // May use only the restricted model and no integration.
      narrow: {
        id: 'narrow',
        permissions: permissions({ apps, models: ['restricted'], integrations: [] })
      },
      builders: { id: 'builders', permissions: permissions({ apps, contentAdmin: true }) },
      admins: { id: 'admins', permissions: permissions({ adminAccess: true }) }
    }
  };
}

export const USER_APP_SETTINGS = {
  limits: { maxAppsPerUser: 20, maxOpenOffersPerUser: 5, ownerSnapshotMaxAgeDays: 30 },
  sharing: { allowUsers: true, allowGroups: true, allowEveryone: true, allowPublish: true },
  capabilities: {
    modelChoice: true,
    upload: true,
    webSearch: true,
    webSearchLimits: { maxPageReads: 10 },
    projects: false,
    skills: false,
    integrations: []
  },
  publishing: { adminEnables: 'withTools' },
  blockedOwners: []
};

export const PLATFORM = {
  defaultLanguage: 'en',
  anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
  aiAcknowledgement: { enabled: false },
  chats: { enabled: true },
  scheduledTasks: { staggerMinutes: 0, minIntervalMinutes: 15, maxTasksPerUser: 10 },
  auth: {},
  userApps: USER_APP_SETTINGS
};

export const FEATURES = {
  userApps: true,
  chatPersistence: true,
  projects: true,
  userProjects: true,
  scheduledTasks: true,
  appAsTool: true,
  integrations: true,
  feedback: true,
  workflows: false
};

/**
 * The company apps of the fixture that a publish stamped
 * (`sourceUserAppId`), by app ID. {@link setConfig} applies them to every
 * app list it installs, so a later `setConfig` keeps them; `reset()` clears
 * them.
 */
const companyAppStamps = new Map();
let installedApps = APPS;

function withStamps(apps) {
  return apps.map(app =>
    companyAppStamps.has(app.id) ? { ...app, sourceUserAppId: companyAppStamps.get(app.id) } : app
  );
}

/**
 * Make the config app `appId` the company app of the personal app
 * `userAppId`, as a publish writes it: a promoted record counts as promoted
 * only while its company app carries its ID.
 *
 * @param {string} appId - A config app of the fixture, e.g. {@link ADMIN_APP}.
 * @param {string} userAppId - The personal app's ID.
 */
export function stampCompanyApp(appId, userAppId) {
  companyAppStamps.set(appId, userAppId);
  configCache.setCacheEntry('config/apps.json', withStamps(installedApps));
}

/**
 * Put the fixture into the config cache.
 *
 * @param {Object} [options]
 * @param {Object[]} [options.apps]
 * @param {Object} [options.features]
 * @param {Object} [options.platform] - Keys merged over {@link PLATFORM}.
 * @param {Object} [options.userApps] - Keys merged over {@link USER_APP_SETTINGS}, part by part.
 * @param {Object} [options.groups] - A whole groups document ({@link groupsWith}).
 * @param {Object} [options.integrations] - `config/integrations.json`.
 */
export function setConfig({
  apps = APPS,
  features = FEATURES,
  platform = {},
  userApps = {},
  groups = groupsWith(),
  integrations = { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } }
} = {}) {
  const merged = { ...USER_APP_SETTINGS };
  for (const [part, value] of Object.entries(userApps)) {
    merged[part] = Array.isArray(value) ? value : { ...USER_APP_SETTINGS[part], ...value };
  }
  configCache.setCacheEntry('config/platform.json', { ...PLATFORM, ...platform, userApps: merged });
  configCache.setCacheEntry('config/features.json', features);
  configCache.setCacheEntry('config/groups.json', groups);
  configCache.setCacheEntry('config/models.json', MODELS);
  installedApps = apps;
  configCache.setCacheEntry('config/apps.json', withStamps(apps));
  configCache.setCacheEntry('config/integrations.json', integrations);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/sources.json', []);
  configCache.setCacheEntry('config/users.json', { users: {} });
}

/** A principal as the request pipeline builds it, from the configuration of this moment. */
export const principal = fields =>
  fields === null
    ? enhanceUserWithPermissions(null, {}, configCache.getPlatform())
    : enhanceUserWithPermissions({ ...fields }, {}, configCache.getPlatform());

/**
 * The people of the fixture. Accounts come from an identity provider (`oidc`),
 * so the owner lookup works without a `users.json` on disk.
 */
export const PEOPLE = {
  anonymous: null,
  // The owner.
  anna: { id: 'anna', name: 'Anna Schmidt', authMode: 'oidc', groups: ['users'] },
  // "Can use".
  ben: { id: 'ben', name: 'Ben Koch', authMode: 'oidc', groups: ['users'] },
  // "Can edit".
  carol: { id: 'carol', name: 'Carol Shaw', authMode: 'oidc', groups: ['users'] },
  // The receiver of an offer.
  dave: { id: 'dave', name: 'Dave Lund', authMode: 'oidc', groups: ['users'] },
  // No share.
  mallory: { id: 'mallory', name: 'Mallory Fox', authMode: 'oidc', groups: ['users'] },
  // In the group `staff`, which is granted the staff app without the wildcard.
  sam: { id: 'sam', name: 'Sam Staff', authMode: 'oidc', groups: ['users', 'staff'] },
  // May use only the restricted model and no integration.
  nora: { id: 'nora', name: 'Nora Narrow', authMode: 'oidc', groups: ['narrow'] },
  builder: { id: 'builder', name: 'Bea Builder', authMode: 'oidc', groups: ['builders'] },
  root: { id: 'root', name: 'Ada Admin', authMode: 'oidc', groups: ['admins'] },
  // Personal API keys: they act as their user.
  annaKey: { id: 'anna', name: 'Anna Schmidt', authMode: 'oauth_personal_key', groups: ['users'] },
  benKey: { id: 'ben', name: 'Ben Koch', authMode: 'oauth_personal_key', groups: ['users'] },
  rootKey: { id: 'root', name: 'Ada Admin', authMode: 'oauth_personal_key', groups: ['admins'] },
  // A third-party app with a token of Ben.
  benDelegated: {
    id: 'ben',
    name: 'Ben Koch',
    authMode: 'oauth_authorization_code',
    groups: ['users']
  },
  client: {
    id: 'client-1',
    name: 'Client',
    isOAuthClient: true,
    authMode: 'oauth_client_credentials',
    groups: ['admins'],
    allowedApps: ['*'],
    allowedModels: ['*']
  },
  agent: { id: 'agent-1', name: 'Agent', isAgent: true, groups: ['admins', 'users'] }
};

/** A member entry. */
export const member = (id, role = 'user', type = 'user') => ({
  type,
  id: type === 'everyone' ? null : id,
  name: id || 'Everyone',
  role
});

/** The content of a personal app that asks for nothing. */
export const plainContent = (extra = {}) => ({
  name: { en: 'Job ad writer' },
  description: { en: 'Drafts a job ad from notes' },
  system: { en: `You write job ads. ${SECRET}` },
  icon: 'document-text',
  color: '#4F46E5',
  variables: [],
  starterPrompts: [],
  capabilities: { upload: false, webSearch: false, skills: false, integrations: [] },
  ...extra
});

export const chatBody = (extra = {}) => ({
  messages: [{ role: 'user', content: 'hello', messageId: `m-${randomUUID()}` }],
  ...extra
});

/**
 * Status and body of an answer with the ID and what differs per request
 * blanked, to compare "forbidden" with "unknown".
 */
export function shape(res, appId) {
  const blank = text =>
    text
      .split(appId)
      .join('<app>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .replace(/file_[0-9a-f]+/g, '<file>')
      .replace(/"instance":"[^"]*"/g, '"instance":"<path>"')
      .replace(/"(timestamp|createdAt|updatedAt|ts)":"[^"]*"/g, '"$1":"<time>"');
  return { status: res.status, body: blank(res.text ?? '') };
}

/**
 * Bring the harness up.
 *
 * @param {Object} [options]
 * @param {boolean} [options.stubTurns=true] - Replace `ChatService.runTurn` with
 *   a stub that records its parameters (`harness.turns`). With `false` the
 *   real turn runs; the test then stubs the model itself.
 * @returns {Promise<Object>}
 */
export async function startUserAppsHarness({ stubTurns = true } = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-user-apps-'));
  await shutdownStorageBootstrap();
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  setConfig();
  // An installation after the upgrade pass of the company app stamps
  // (`companyAppStamps.js`): only a stamped company app keeps its record
  // promoted. A test of the pass itself switches this back.
  setCompanyAppStampsChecked(true);
  await configCache.loadAndCacheLocale('en');
  const ledger = await captureRunLog();

  const people = new Map(Object.entries(PEOPLE));
  const turns = [];
  const magicCalls = [];
  const originals = {
    verifyApiKey: ApiKeyVerifier.prototype.verifyApiKey,
    runTurn: ChatService.prototype.runTurn
  };
  ApiKeyVerifier.prototype.verifyApiKey = async () => ({ success: true, apiKey: 'sk-test' });
  if (stubTurns) {
    ChatService.prototype.runTurn = async function (params) {
      turns.push(params);
      return { status: 'success', content: 'stub answer', finishReason: 'stop' };
    };
  }

  const user = name => {
    if (!people.has(name)) throw new Error(`Unknown test principal: ${name}`);
    return principal(people.get(name));
  };

  const api = express();
  api.use(express.json());
  // The principal comes from a header the test sets, never from the body.
  api.use((req, _res, next) => {
    req.user = user(req.headers['x-test-principal'] || 'anonymous');
    next();
  });
  const getLocalizedError = async code => `localized:${code}`;
  registerGeneralRoutes(api, { getLocalizedError });
  registerSessionRoutes(api, { getLocalizedError, DEFAULT_TIMEOUT: 5000 });
  registerMagicPromptRoutes(api, {
    llmClient: {
      complete: async call => {
        magicCalls.push(call);
        return { content: 'improved' };
      }
    }
  });
  registerConversationRoutes(api);
  registerFeedbackRoutes(api, { getLocalizedError });
  registerChatRoutes(api);
  registerWorkflowRoutes(api);
  api.use('/api/integrations', scopeRoutes);
  api.use('/api/integrations', userIntegrationRoutes);
  api.use(errorHandler);

  const repo = () => getUserAppRepository();

  /**
   * Create a personal app in the store.
   *
   * @param {string} ownerName - A key of the people.
   * @param {Object} [options]
   * @param {Object} [options.content] - Keys merged over {@link plainContent}.
   * @param {Object[]} [options.members]
   * @param {(record: Object) => Object} [options.change] - A change of the stored
   *   record after creation (`disabled`, `state`, `ownerPrincipalAt`, …).
   * @returns {Promise<Object>} The stored record.
   */
  async function createApp(ownerName, { content = {}, members = [], change = null } = {}) {
    const owner = user(ownerName);
    const parsed = userAppContentSchema.parse(plainContent(content));
    let record = await repo().create({
      owner: { id: owner.id, name: owner.name },
      ownerPrincipal: userAppOwnerSnapshot(owner),
      content: parsed,
      language: 'en',
      origin: 'blank'
    });
    if (members.length > 0) {
      ({ record } = await repo().setMembers(record.id, members, {
        actor: { id: owner.id, name: owner.name }
      }));
    }
    if (change) record = await repo().mutate(record.id, change, { bumpRevision: false });
    return record;
  }

  /** A stored chat of `name` that belongs to `appId`. */
  async function seedChat(name, appId) {
    const owner = await resolveChatOwner(user(name), {});
    if (!owner) return null;
    const chatId = randomUUID();
    await getChatRepository().ensureChat({
      chatId,
      ownerId: owner.id,
      identityMode: owner.mode,
      appId,
      origin: { createdVia: 'ui' },
      temporary: false
    });
    return chatId;
  }

  /** A request builder that sends as one of the people. */
  const as = name => {
    const agent = request(api);
    const withPrincipal = method => url => agent[method](url).set('x-test-principal', name);
    return {
      get: withPrincipal('get'),
      post: withPrincipal('post'),
      put: withPrincipal('put'),
      patch: withPrincipal('patch'),
      delete: withPrincipal('delete')
    };
  };

  return {
    api,
    turns,
    magicCalls,
    ledger,
    user,
    as,
    repo,
    createApp,
    seedChat,
    addPerson(name, fields) {
      people.set(name, fields);
    },
    /**
     * Back to the default configuration, with no personal app in the store
     * and nothing remembered from earlier tests.
     */
    async reset() {
      companyAppStamps.clear();
      setCompanyAppStampsChecked(true);
      setConfig();
      turns.length = 0;
      magicCalls.length = 0;
      resetUserAppRunMemory();
      for (;;) {
        const { items } = await repo().scan({ limit: 200 });
        if (items.length === 0) break;
        for (const record of items) await repo().delete(record.id, { keepLastState: false });
      }
    },
    async stop() {
      ApiKeyVerifier.prototype.verifyApiKey = originals.verifyApiKey;
      ChatService.prototype.runTurn = originals.runTurn;
      await shutdownStorageBootstrap();
      const rm = dir =>
        fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(baseDir);
      if (ledger?.baseDir) await rm(ledger.baseDir);
      for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
    }
  };
}
