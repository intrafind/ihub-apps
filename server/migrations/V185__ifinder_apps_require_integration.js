// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V185 — iFinder apps follow the iFinder integration
 *
 * - Removes the retired `ifinder-document-actions` app, which `ifinder-search`
 *   replaces. The Parliamentary Questions Analyzer hands its questions to
 *   `ifinder-search` instead.
 * - Adds `requiredIntegrations: ["ifinder"]` to `iassistant` and
 *   `ifinder-search`: users get them only while the iFinder integration is on.
 *   An app's `enabled` flag is left as the admin set it.
 */

export const version = '185';
export const description = 'ifinder_apps_require_integration';

const REMOVED_APP = 'ifinder-document-actions';
const REPLACEMENT_APP = 'ifinder-search';
const INTEGRATION_APPS = ['iassistant', 'ifinder-search'];

export async function precondition(ctx) {
  const files = await ctx.listFiles('apps', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('apps', '*.json');

  if (files.includes(`${REMOVED_APP}.json`)) {
    await ctx.deleteFile(`apps/${REMOVED_APP}.json`);
    ctx.log(`Removed apps/${REMOVED_APP}.json`);
  }

  for (const id of INTEGRATION_APPS) {
    if (!files.includes(`${id}.json`)) continue;
    const path = `apps/${id}.json`;
    const app = await ctx.readJson(path);
    if (!app || typeof app !== 'object') continue;
    const required = Array.isArray(app.requiredIntegrations) ? app.requiredIntegrations : [];
    if (required.includes('ifinder')) continue;
    app.requiredIntegrations = [...required, 'ifinder'];
    await ctx.writeJson(path, app);
    ctx.log(`${path} now requires the iFinder integration`);
  }

  const parliamentary = files.includes('parliamentary-questions.json')
    ? await ctx.readJson('apps/parliamentary-questions.json')
    : null;
  if (parliamentary?.rendererConfig?.iAssistantAppId === REMOVED_APP) {
    parliamentary.rendererConfig.iAssistantAppId = REPLACEMENT_APP;
    await ctx.writeJson('apps/parliamentary-questions.json', parliamentary);
    ctx.log(`parliamentary-questions now hands over to ${REPLACEMENT_APP}`);
  }
}
