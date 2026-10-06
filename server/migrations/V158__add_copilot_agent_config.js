/**
 * Migration V158 — Microsoft 365 Copilot agent settings
 *
 * Adds the `copilotAgent` section of platform.json, which Admin → Integrations
 * → Microsoft 365 Copilot edits (see server/routes/admin/copilotAgent.js and
 * server/utils/copilotAgentPackage.js). The agent is off until an admin turns
 * it on: enabling it creates the OAuth client Copilot signs users in with and
 * fills in `appId` and `oauthClientId`; `oauthReferenceId` is the OAuth client
 * registration ID the admin brings from the Teams Developer Portal.
 *
 * Fresh installs get the section from server/defaults/config/platform.json.
 * Only missing values are added; an admin's values stay.
 */
export const version = '158';
export const description = 'add_copilot_agent_config';

export const COPILOT_AGENT_DEFAULTS = Object.freeze({
  enabled: false,
  appId: '',
  oauthClientId: '',
  oauthReferenceId: '',
  name: 'iHub Apps',
  description:
    "Use your organization's iHub apps — assistants, writing aids and knowledge search — right in Microsoft 365 Copilot.",
  instructions: '',
  conversationStarters: []
});

/**
 * Run only where a platform config exists.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<boolean>}
 */
export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Add the `copilotAgent` defaults that are missing.
 *
 * @param {Object} ctx - Migration context.
 * @returns {Promise<void>}
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  let changed = false;
  for (const [key, value] of Object.entries(COPILOT_AGENT_DEFAULTS)) {
    const fresh = Array.isArray(value) ? [...value] : value;
    if (ctx.setDefault(platform, `copilotAgent.${key}`, fresh)) changed = true;
  }
  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Added copilotAgent defaults (enabled=false)');
  } else {
    ctx.log('copilotAgent already configured — skipping');
  }
}
