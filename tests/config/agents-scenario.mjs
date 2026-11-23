// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Names and ports of the agents end-to-end suite (`tests/e2e-agents/`), shared by
 * the server script (`agents-server.mjs`), the Playwright config and the specs.
 * Ports and the contents directory are the suite's own, so it runs next to another
 * suite in the same checkout.
 */

export const SERVER_PORT = Number(process.env.E2E_AGENTS_SERVER_PORT) || 3501;
export const CLIENT_PORT = Number(process.env.E2E_AGENTS_CLIENT_PORT) || 5591;
export const LLM_PORT = Number(process.env.E2E_AGENTS_LLM_PORT) || 8994;
/** The suite's helper: restarts the server (see agents-server.mjs). */
export const CONTROL_PORT = Number(process.env.E2E_AGENTS_CONTROL_PORT) || 8995;
export const CONTENTS_DIR = 'contents-e2e-agents';

/**
 * The overlay this run's server was started with (`agents-run.mjs matrix`), or
 * `seeded` for the settings as seeded.
 */
export const OVERLAY_NAME = /^[a-z0-9][a-z0-9-]*$/.test(process.env.E2E_AGENTS_OVERLAY_NAME || '')
  ? process.env.E2E_AGENTS_OVERLAY_NAME
  : 'seeded';

export const BASE_URL = `http://127.0.0.1:${CLIENT_PORT}`;
export const LLM = `http://127.0.0.1:${LLM_PORT}`;
export const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

/** The model ids of the two stub models (e2e-contents.mjs). */
export const MODELS = { default: 'e2e-stub', tools: 'e2e-stub-tools' };

/**
 * The suite's own app: it prefers the stub model with tools and offers iHub's own
 * tools (the `ihub` integration: `ask_user` and the scheduled-task tools), which
 * need no network. `list_scheduled_tasks` only reads.
 */
export const TOOLS_APP = 'e2e-tools';

/**
 * The app of {@link TOOLS_APP} once more, with one difference: every tool call
 * asks for the person's approval first (`toolApproval.default: 'always'`). A spec
 * that needs a pending approval sends its tool call here.
 */
export const APPROVAL_APP = 'e2e-approval';

/** The default local admin of a fresh install. */
export const ADMIN = { id: 'user_demo_admin', username: 'admin', password: 'password123' };
/** A regular user (group `users`): owns the runs and chats the specs start. */
export const USER = {
  id: 'user_e2e_user',
  username: 'e2e-user',
  password: 'e2e-user-password-1',
  name: 'E2E User',
  email: 'e2e-user@example.com'
};
/** A second regular user: must never see or change what {@link USER} owns. */
export const OTHER = {
  id: 'user_e2e_other',
  username: 'e2e-other',
  password: 'e2e-other-password-1',
  name: 'E2E Other',
  email: 'e2e-other@example.com'
};
