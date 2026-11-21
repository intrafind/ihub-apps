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
/**
 * An app that is not published (`enabled: false`). The `users` group may use
 * every app, so what keeps alice and bob out is the published rule alone; a
 * content admin or admin can try it in the interactive chat.
 */
export const UNPUBLISHED_APP_ID = 'authz-unpublished-app';
/** In the unpublished app's name and instructions; never in an answer to a user. */
export const UNPUBLISHED_APP_MARKER = 'AUTHZ-UNPUBLISHED-APP-9d2e';
/** No app has this id. */
export const UNKNOWN_APP_ID = 'authz-no-such-app';
export const SECRET_MODEL_ID = 'authz-secret-model';
export const SECRET_PROMPT_ID = 'authz-secret-prompt';
/** A global skill carol's group may not use (it may use none). */
export const SECRET_SKILL_ID = 'interview-to-blog';
/** A page restricted to the `users` group. */
export const SECRET_PAGE_ID = 'authz-members';
/** A workflow that stops at a human checkpoint (no model call); only `users` may run it. */
export const WORKFLOW_ID = 'authz-workflow';
/** An agent profile that runs {@link WORKFLOW_ID}. */
export const AGENT_PROFILE_ID = 'authz-agent';

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
