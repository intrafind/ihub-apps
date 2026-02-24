/**
 * Migration V005 — Switch JWT algorithm to RS256
 *
 * Changes the default JWT signing algorithm from HS256 (symmetric) to RS256 (asymmetric).
 * This enables public key sharing via the /.well-known/jwks.json endpoint, allowing
 * external applications to validate JWT tokens issued by iHub Apps.
 *
 * Note: This will invalidate all existing JWT tokens, requiring users to login again.
 * This is acceptable as it improves security and enables proper external token validation.
 *
 * Fresh installs skip this automatically because performInitialSetup() copies the defaults
 * (which already include jwt.algorithm: "RS256") before migrations run.
 */

export const version = '005';
export const description = 'Switch JWT algorithm to RS256 for public key sharing';

export async function precondition(ctx) {
  // Only run if platform.json exists
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Check if jwt config already exists
  const currentAlgorithm = platform.jwt?.algorithm;

  if (currentAlgorithm === 'RS256') {
    ctx.log('JWT algorithm already set to RS256 — skipping');
    return;
  }

  // Set the jwt configuration with RS256 algorithm
  const changed = ctx.setDefault(platform, 'jwt', {
    algorithm: 'RS256'
  });

  if (changed || currentAlgorithm !== 'RS256') {
    // Ensure algorithm is RS256 even if jwt object existed
    if (!platform.jwt) {
      platform.jwt = {};
    }
    platform.jwt.algorithm = 'RS256';

    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Switched JWT algorithm to RS256');
    ctx.log('Note: All existing JWT tokens will be invalidated. Users will need to login again.');
  } else {
    ctx.log('JWT configuration already present — skipping');
  }
}
