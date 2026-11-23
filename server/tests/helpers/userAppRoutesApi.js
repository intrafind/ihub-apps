// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The user routes of personal apps (`routes/userAppRoutes.js`) on an Express
 * app of their own, over the harness of the chat path
 * (`helpers/userAppsHarness.js`): the same config cache, store and people.
 *
 * The user routes are registered before the general routes, as on the server.
 * The users database of share targets and offers is {@link USERS}; the people
 * of the harness sign in through an identity provider, so nothing else reads
 * a `users.json`.
 *
 * ```js
 * let api;
 * before(async () => { api = await startUserAppRoutesApi(); });
 * after(() => api.stop());
 * beforeEach(() => api.reset());
 *
 * const res = await api.as('anna').post('/api/apps').send(body());
 * ```
 */
import express from 'express';
import request from 'supertest';

import errorHandler from '../../middleware/errorHandler.js';
import registerGeneralRoutes from '../../routes/generalRoutes.js';
import registerUserAppRoutes from '../../routes/userAppRoutes.js';
import { queryAuditLog } from '../../services/AuditLogService.js';
import { UserAppService } from '../../services/userApps/UserAppService.js';
import { PEOPLE, startUserAppsHarness } from './userAppsHarness.js';

/** The users database: every person of the harness, and one deactivated account. */
export const USERS = Object.freeze({
  ...Object.fromEntries(
    Object.entries(PEOPLE)
      .filter(([name, person]) => person && name === person.id && !person.isOAuthClient)
      .map(([id, person]) => [
        id,
        { id, username: id, name: person.name, email: `${id}@example.org`, active: true }
      ])
  ),
  gone: { id: 'gone', username: 'gone', name: 'Gina Gone', email: null, active: false }
});

/** The body of `POST /api/apps` for an app that asks for nothing. */
export const createBody = (extra = {}) => ({
  language: 'en',
  origin: 'blank',
  name: { en: 'Job ad writer' },
  description: { en: 'Drafts a job ad from notes' },
  system: { en: 'You write job ads.' },
  ...extra
});

/**
 * Bring the routes up.
 *
 * @param {Object} [options]
 * @param {{ complete: Function }} [options.llmClient] - The model client of the draft route.
 * @returns {Promise<Object>} The harness, with `api` and `as` of this Express app,
 *   `chatAs` (requests against the harness's chat routes), `audit(appId, filter)`,
 *   `drafts` (the calls the model client received), `model.answer` (what the model
 *   answers) and `users` (the users database, to add an account).
 */
export async function startUserAppRoutesApi({ llmClient } = {}) {
  const harness = await startUserAppsHarness();
  const drafts = [];
  const model = {
    answer: { name: 'Mail summary', system: 'You summarize mails.', description: 'Summarizes.' }
  };

  // A copy per start, so a test can add an account.
  const users = { ...USERS };

  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    req.user = harness.user(req.headers['x-test-principal'] || 'anonymous');
    next();
  });
  registerUserAppRoutes(api, {
    service: new UserAppService({ users: () => users }),
    llmClient: llmClient || {
      complete: async call => {
        drafts.push(call);
        return { content: JSON.stringify(model.answer), finishReason: 'stop', usage: null };
      }
    }
  });
  registerGeneralRoutes(api, { getLocalizedError: async code => `localized:${code}` });
  api.use(errorHandler);

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

  /**
   * The audit entries about one app, oldest first.
   *
   * @param {string} resourceId - App ID.
   * @param {Object} [filter] - `resource`, `action`.
   * @returns {Promise<Object[]>}
   */
  async function audit(resourceId, filter = {}) {
    const { entries } = await queryAuditLog({ ...filter, limit: 1000 });
    return entries
      .filter(entry => entry.resourceId === resourceId)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }

  return {
    ...harness,
    api,
    as,
    /** Requests against the routes of the chat path (the harness's own Express app). */
    chatAs: harness.as,
    audit,
    drafts,
    model,
    users
  };
}
