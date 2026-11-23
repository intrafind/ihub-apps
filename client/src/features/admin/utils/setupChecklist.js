// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Overview's "Getting started" checklist: which first setup steps are done, decided from what
 * the server reports, never assumed. A step is ticked only on a positive signal; when a signal
 * could not be read, the step stays open rather than claiming a state nobody checked.
 *
 * @module features/admin/utils/setupChecklist
 */

/** The demo administrator whose shipped password the login page prints. */
const DEMO_ADMIN_USERNAME = 'admin';

/** Key states from `GET /admin/models/_key-status` under which a model can be called. */
const USABLE_KEY_STATES = new Set(['ok', 'keyless']);

/**
 * @typedef {Object} SetupStep
 * @property {'install'|'admin'|'provider'|'app'|'identity'} id - Step id; the page maps it to a label.
 * @property {boolean} done - True only when the server confirmed the step.
 * @property {boolean} optional - Optional steps never keep the checklist on screen.
 * @property {string|null} href - Admin page where the step is done, or null.
 * @property {'shippedPassword'} [hint] - Why an open step is open, when the server said so.
 */

/**
 * Builds the setup steps from the server's answers.
 *
 * - **Admin account ready**: local sign-in is off, or the demo `admin` account no longer signs in
 *   with its shipped password (`GET /admin/auth/demo-accounts`).
 * - **Configure an LLM provider**: at least one enabled chat model has a usable credential (a key
 *   the server can use, or none needed) (`GET /admin/models/_key-status`).
 * - **Create your first app**: listed only while the server reports no apps at all; a real install
 *   ships 27 (18 enabled), so the step does not tick for apps nobody created.
 * - **Connect identity provider** (optional): an OIDC or LDAP provider people can sign in with
 *   (the stats count only enabled ones), or proxy sign-in, is set up.
 *
 * @param {Object} input
 * @param {{accounts?: string[]}|null} [input.demoAccounts] - Demo account status, or null if unknown.
 * @param {Array<{enabled: boolean, state: string}>|null} [input.modelKeyStatuses] - Key status
 *   items, or null if unknown.
 * @param {Object|null} [input.overviewStats] - `GET /admin/overview/stats`, or null if unknown.
 * @returns {SetupStep[]}
 *
 * @example
 * buildSetupSteps({
 *   demoAccounts: { accounts: ['admin'] },
 *   modelKeyStatuses: [{ id: 'gpt', enabled: true, state: 'missing' }],
 *   overviewStats: { apps: { total: 27 }, auth: { local: true } }
 * }).filter(step => !step.done).map(step => step.id); // ['admin', 'provider', 'identity']
 */
export function buildSetupSteps({
  demoAccounts = null,
  modelKeyStatuses = null,
  overviewStats = null
} = {}) {
  const auth = overviewStats?.auth || null;

  const localSignInOff = auth?.local === false;
  const demoAccountsKnown = Array.isArray(demoAccounts?.accounts);
  const demoAdminChanged =
    demoAccountsKnown && !demoAccounts.accounts.includes(DEMO_ADMIN_USERNAME);
  const adminDone = localSignInOff || demoAdminChanged;

  const providerReady =
    Array.isArray(modelKeyStatuses) &&
    modelKeyStatuses.some(status => status?.enabled && USABLE_KEY_STATES.has(status.state));

  const identityConnected = Boolean(
    auth && (auth.oidcProviders > 0 || auth.ldapProviders > 0 || auth.proxy === true)
  );

  const steps = [
    // The admin is looking at the installed platform: the one step that is true by definition.
    { id: 'install', done: true, optional: false, href: null },
    {
      id: 'admin',
      done: adminDone,
      optional: false,
      href: '/admin/users',
      ...(!adminDone && demoAccountsKnown ? { hint: 'shippedPassword' } : {})
    },
    { id: 'provider', done: providerReady, optional: false, href: '/admin/providers/connect' }
  ];

  if (overviewStats?.apps?.total === 0) {
    steps.push({ id: 'app', done: false, optional: false, href: '/admin/apps' });
  }

  steps.push({ id: 'identity', done: identityConnected, optional: true, href: '/admin/auth' });
  return steps;
}

/**
 * Whether the checklist has something left to do: at least one required step is open.
 *
 * @param {SetupStep[]} steps
 * @returns {boolean}
 */
export function hasOpenSetupSteps(steps) {
  return Array.isArray(steps) && steps.some(step => !step.optional && !step.done);
}
