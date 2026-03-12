export const version = '019';
export const description = 'migrate_oauth_enabled_to_nested_structure';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  const oauthSection = platform?.oauth || {};
  const existingEnabled = oauthSection.enabled;

  // Determine previous state and migrate accordingly
  let authzEnabled = false;
  let clientsEnabled = false;

  if (
    typeof existingEnabled === 'object' &&
    existingEnabled !== null &&
    ('authz' in existingEnabled || 'clients' in existingEnabled)
  ) {
    // Already in the correct nested format — keep as-is
    authzEnabled = existingEnabled.authz === true;
    clientsEnabled = existingEnabled.clients === true;
  } else if (typeof existingEnabled === 'boolean') {
    // Old flat boolean: if auth server was on, both sub-features stay on
    authzEnabled = existingEnabled;
    clientsEnabled = existingEnabled;
  } else if (
    typeof existingEnabled !== 'object' &&
    typeof oauthSection.clientsEnabled === 'boolean'
  ) {
    // Intermediate format: a previous run of this migration added clientsEnabled
    // alongside the old flat boolean.  Honour both values.
    authzEnabled = typeof existingEnabled === 'boolean' ? existingEnabled : false;
    clientsEnabled = oauthSection.clientsEnabled;
  }

  // Write nested structure
  platform.oauth = {
    ...oauthSection,
    enabled: {
      authz: authzEnabled,
      clients: clientsEnabled
    }
  };

  // Remove the now-superseded flat field if it was added by a previous run
  delete platform.oauth.clientsEnabled;

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Migrated oauth.enabled to { authz: ${authzEnabled}, clients: ${clientsEnabled} }`);
}
