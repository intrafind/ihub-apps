/**
 * Migration V010 — Remove legacy jwtSecret field
 *
 * V009 switched JWT signing to RS256 (asymmetric key pairs), making the legacy
 * `jwtSecret` shared secret obsolete. This migration removes the field from
 * both `auth.jwtSecret` and `localAuth.jwtSecret` locations to avoid confusion.
 */

export const version = '010';
export const description = 'Remove legacy jwtSecret field superseded by RS256 key pairs';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  let changed = false;

  if (platform.auth?.jwtSecret !== undefined) {
    ctx.removeKey(platform, 'auth.jwtSecret');
    ctx.log('Removed auth.jwtSecret');
    changed = true;
  }

  if (platform.localAuth?.jwtSecret !== undefined) {
    ctx.removeKey(platform, 'localAuth.jwtSecret');
    ctx.log('Removed localAuth.jwtSecret');
    changed = true;
  }

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
  } else {
    ctx.log('No jwtSecret fields found — skipping');
  }
}
