// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The setup the tests of the iFinder tier of projects share: a fake iFinder, a
 * filesystem storage, the platform, features and groups configuration, a users
 * database, and `drive()`, which runs a route of `/api/projects` the way express
 * would (the path guards first, then the route's own handlers, with `req.route`
 * and `req.path` set as express sets them).
 *
 * Import it **before** anything that reads `config.js`: the iFinder JWT is signed
 * with a key taken from the environment, which `createHarness` puts there.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectionDocument, generatePrivateKeyPem, startMockIFinder } from './mockIFinder.js';
import { installationsFor } from './installedIFinder.js';

export const GROUP = ['authenticated'];

/** The `n`-th collection id, a UUID. */
export const collectionId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function captureRoutes(register) {
  const routes = [];
  const guards = [];
  const record =
    method =>
    (routePath, ...handlers) =>
      routes.push({ method, routePath, handlers });
  register({
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: (routePath, ...handlers) => guards.push({ routePath, handlers })
  });
  return { routes, guards };
}

export function makeResponse() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    res.body = value;
    return res;
  };
  res.end = () => res;
  res.send = value => {
    res.body = value;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  return res;
}

/**
 * @param {Object} options
 * @param {Object[]} options.users - Users the local database knows (`id`, `email`, `groups`).
 */
export async function createHarness({ users: userList }) {
  process.env.IFINDER_PRIVATE_KEY = await generatePrivateKeyPem();
  delete process.env.IFINDER_API_URL;
  const { default: configCache } = await import('../../configCache.js');
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../../storage/bootstrap.js');
  const { resolveGroupInheritance } = await import('../../utils/authorization.js');
  const { locateConfigFile } = await import('../../utils/configFileLocation.js');
  const { default: registerProjectRoutes } = await import('../../routes/projectRoutes.js');
  const { default: iFinderService } = await import('../../services/integrations/iFinderService.js');
  const { resetIFinderTier } = await import('../../services/projects/ifinder/IFinderTier.js');
  const { setStorageResolver } = await import('../../services/projects/ifinder/collectionLock.js');

  const ifinder = await startMockIFinder();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-ifinder-writes-'));
  const baseDir = path.join(scratch, 'data');
  await bootstrapStorage({
    storage: { provider: 'filesystem', filesystem: { baseDir, flushIntervalMs: 25 } }
  });
  const users = {};
  for (const user of userList) {
    users[user.id] = { ...user, username: user.id.replace('user-', ''), active: true };
  }
  const usersFile = path.join(scratch, 'users.json');
  await fs.writeFile(usersFile, JSON.stringify({ users }), 'utf8');
  configCache.setCacheEntry(locateConfigFile(usersFile).cacheKey, { users, metadata: {} });
  const platform = {
    defaultLanguage: 'en',
    localAuth: { usersFile },
    anonymousAuth: { enabled: true, defaultGroups: ['anonymous'] },
    chats: { enabled: true },
    proxy: { enabled: false }
  };
  configCache.setCacheEntry('config/features.json', {
    projects: true,
    userProjects: true,
    chatPersistence: true
  });
  configCache.setCacheEntry(
    'config/groups.json',
    resolveGroupInheritance({
      groups: {
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: { apps: ['chat'], projects: true, projectSharing: true }
        },
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: { apps: ['chat'] } },
        nocreate: {
          id: 'nocreate',
          name: 'No create',
          inherits: ['anonymous'],
          permissions: { apps: ['chat'] }
        }
      }
    })
  );
  configCache.setCacheEntry('config/apps.json', [
    { id: 'chat', name: { en: 'Chat' }, enabled: true }
  ]);
  configCache.setCacheEntry('config/workflows.json', []);
  configCache.setCacheEntry('config/agents.json', []);
  configCache.setCacheEntry('config/projects.json', []);

  const projects = captureRoutes(registerProjectRoutes);

  const harness = {
    ifinder,
    projects,
    baseDir,
    platform,
    configCache,
    setPlatform({ tierPolicy = 'both', iFinder = { baseUrl: ifinder.url } } = {}) {
      platform.projects = { tierPolicy, limits: { maxProjectsPerUser: 0 } };
      platform.iFinder = { ...iFinder, ...(iFinder.baseUrl ? { jwtSubjectField: 'email' } : {}) };
      configCache.setCacheEntry('config/platform.json', platform);
      configCache.setCacheEntry(
        'config/integrations.json',
        installationsFor({ iFinder: platform.iFinder })
      );
      iFinderService.resetConfig();
    },
    /** The registered handlers of one route, by method and the end of its path. */
    handlersFor(method, suffix) {
      const found = projects.routes.find(
        entry => entry.method === method && entry.routePath.endsWith(suffix)
      );
      if (!found) throw new Error(`${method.toUpperCase()} ${suffix} must be registered`);
      return found.handlers;
    },
    /** Run a route the way express would: the path guards first, then its handlers. */
    async drive(
      handlers,
      { params = {}, query = {}, body = {}, user, method = 'GET', headers = {} } = {}
    ) {
      const req = {
        params,
        query,
        body,
        headers,
        user: user ? { ...user, groups: [...(user.groups || [])] } : undefined,
        ip: '127.0.0.1',
        method,
        url: '/'
      };
      const res = makeResponse();
      const registered = projects.routes.find(entry => entry.handlers === handlers);
      if (registered) {
        req.route = { path: registered.routePath };
        const below = registered.routePath.split(':projectId')[1] || '';
        req.path = below.replace(':itemId', params.itemId ?? 'itm_x') || '/';
      }
      const guards =
        params.projectId === undefined ? [] : projects.guards.flatMap(guard => guard.handlers);
      for (const handler of [...guards, ...handlers]) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) break;
      }
      return res;
    },
    collection(n, owner, { name = `Collection ${n}`, documents = [], description = '' } = {}) {
      ifinder.addCollection(
        collectionDocument({ id: collectionId(n), owner, name, documents, description })
      );
    },
    /** Between tests: forget the fake's state and everything the tier cached. */
    reset() {
      setStorageResolver();
      ifinder.state.collections.clear();
      ifinder.state.documents.clear();
      ifinder.reset();
      resetIFinderTier();
      harness.setPlatform();
    },
    async close() {
      setStorageResolver();
      await ifinder.close();
      await shutdownStorageBootstrap();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  };
  harness.setPlatform();
  return harness;
}
