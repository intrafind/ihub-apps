// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The principals of the cross-user authorization suite, shared by the server
 * launcher (`tests/config/authz-server.mjs`, which seeds them) and the specs
 * (which sign in as them). Test-only accounts in a disposable contents directory.
 */

/** Carol's only group: no access to the secret app, model and prompt. */
export const RESTRICTED_GROUP = 'authz-restricted';
export const SECRET_APP_ID = 'authz-secret-app';
export const SECRET_MODEL_ID = 'authz-secret-model';
export const SECRET_PROMPT_ID = 'authz-secret-prompt';
/** A global skill carol's group may not use (it may use none). */
export const SECRET_SKILL_ID = 'interview-to-blog';
/** A page restricted to the `users` group. */
export const SECRET_PAGE_ID = 'authz-members';
/** A workflow that stops at a human checkpoint (no model call); only `users` may run it. */
export const WORKFLOW_ID = 'authz-workflow';

export const AUTHZ_USERS = {
  alice: {
    id: 'user_authz_alice',
    username: 'alice',
    password: 'alice-authz-pass-1',
    groups: ['users']
  },
  bob: { id: 'user_authz_bob', username: 'bob', password: 'bob-authz-pass-1', groups: ['users'] },
  carol: {
    id: 'user_authz_carol',
    username: 'carol',
    password: 'carol-authz-pass-1',
    groups: [RESTRICTED_GROUP]
  },
  admin: { id: 'user_demo_admin', username: 'admin', password: 'password123', groups: ['admins'] }
};
