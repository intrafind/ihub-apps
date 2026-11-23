// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The contents seed of the app builder suite (`playwright.app-builder.config.js`,
 * `tests/e2e/app-builder.spec.js`). It runs once, after the suite's own server is
 * up and before the first test (Playwright `globalSetup`).
 *
 * A fresh install has no content-admin group, and its only accounts are `admin`
 * and `user`. Without the seed every case would run as the full administrator,
 * and the people the app builder is for (someone who manages apps without being
 * an administrator) would never be tested. The seed adds, through the admin API
 * an administrator would use:
 *
 * - the group `app-builders` with `contentAdmin: true`. It inherits from
 *   `authenticated` and grants nothing itself, so its members can use an app only
 *   through the wildcard of `authenticated` or through a grant to this group.
 *   That is what the case "wildcard removed" needs: the spec empties
 *   `authenticated.permissions.apps` for one test and restores it.
 * - the user `builder` in that group.
 *
 * Running it twice changes nothing: an existing group or user is kept.
 */

import { request } from '@playwright/test';

/** The default local admin of a fresh contents directory. */
export const ADMIN = Object.freeze({ username: 'admin', password: 'password123' });

/** The default account without any admin right. */
export const NORMAL_USER = Object.freeze({ username: 'user', password: 'password123' });

/** A content admin who is not a full administrator. */
export const BUILDER = Object.freeze({
  username: 'builder',
  password: 'builder-e2e-pass',
  name: 'App Builder',
  email: 'builder@example.com'
});

/** The content-admin group `builder` is a member of. */
export const BUILDER_GROUP = Object.freeze({
  id: 'app-builders',
  name: 'App builders',
  description: 'App builder e2e suite: may manage apps without being an administrator',
  inherits: ['authenticated'],
  permissions: {
    apps: [],
    prompts: [],
    models: [],
    skills: [],
    workflows: [],
    integrations: [],
    adminAccess: false,
    contentAdmin: true
  },
  mappings: []
});

/**
 * @param {import('@playwright/test').APIResponse} response
 * @param {string} what - Named in the error
 * @param {number[]} [accepted] - Statuses besides 2xx that are fine
 */
async function expectOk(response, what, accepted = []) {
  if (response.ok() || accepted.includes(response.status())) return;
  const body = (await response.text().catch(() => '')).slice(0, 500);
  throw new Error(`App builder seed: ${what} answered HTTP ${response.status()}: ${body}`);
}

/**
 * @param {import('@playwright/test').FullConfig} config
 * @returns {Promise<void>}
 */
export default async function seedAppBuilderContents(config) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('App builder seed: the config has no baseURL');
  const api = await request.newContext({ baseURL });
  try {
    await expectOk(
      await api.post('/api/auth/local/login', { data: ADMIN }),
      'the sign-in as the default admin'
    );

    // 409: the group is there from an earlier run against a kept server.
    await expectOk(
      await api.post('/api/admin/groups', { data: BUILDER_GROUP }),
      `creating the group ${BUILDER_GROUP.id}`,
      [409]
    );

    const listed = await api.get('/api/admin/auth/users');
    await expectOk(listed, 'listing the users');
    const { users = {} } = await listed.json();
    const exists = Object.values(users).some(user => user.username === BUILDER.username);
    if (!exists) {
      await expectOk(
        await api.post('/api/admin/auth/users', {
          data: {
            username: BUILDER.username,
            password: BUILDER.password,
            name: BUILDER.name,
            email: BUILDER.email,
            internalGroups: [BUILDER_GROUP.id],
            active: true
          }
        }),
        `creating the user ${BUILDER.username}`
      );
    }

    // The seed is only good when the new account really is a content admin and
    // nothing more: fail here, with a reason, instead of in the first test.
    const builder = await request.newContext({ baseURL });
    try {
      await expectOk(
        await builder.post('/api/auth/local/login', {
          data: { username: BUILDER.username, password: BUILDER.password }
        }),
        `the sign-in as ${BUILDER.username}`
      );
      await expectOk(await builder.get('/api/admin/apps'), 'the app list for the content admin');
      const models = await builder.get('/api/admin/models');
      if (models.ok()) {
        throw new Error(
          `App builder seed: ${BUILDER.username} can open the admin model list, so the account is a full administrator`
        );
      }
    } finally {
      await builder.dispose();
    }
  } finally {
    await api.dispose();
  }
}
