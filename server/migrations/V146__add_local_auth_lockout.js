// server/migrations/V146__add_local_auth_lockout.js
export const version = '146';
export const description = 'add_local_auth_lockout';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

/**
 * Local sign-in locks an account for a while after repeated failed attempts
 * (see utils/loginLockout.js). Seed the settings so admins can see and tune
 * them; values an admin already set are kept.
 */
export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  ctx.setDefault(platform, 'localAuth.lockout.enabled', true);
  ctx.setDefault(platform, 'localAuth.lockout.maxAttempts', 5);
  ctx.setDefault(platform, 'localAuth.lockout.durationMinutes', 15);
  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added localAuth.lockout defaults (5 failed sign-ins lock an account for 15 minutes)');
}
