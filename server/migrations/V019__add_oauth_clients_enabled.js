export const version = '019';
export const description = 'add_oauth_clients_enabled';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // For existing installs where the OAuth Authorization Server is already enabled,
  // automatically enable the OAuth Clients feature so nothing breaks.
  // New installs get false as the default (opt-in).
  const oauthEnabled = platform?.oauth?.enabled === true;
  ctx.setDefault(platform, 'oauth.clientsEnabled', oauthEnabled);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log(`Added oauth.clientsEnabled = ${oauthEnabled}`);
}
