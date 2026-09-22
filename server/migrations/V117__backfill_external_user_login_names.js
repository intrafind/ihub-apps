/**
 * Migration V117 — Backfill the login name on externally authenticated users
 *
 * Background: `createOrUpdateExternalUser()` wrote `username: externalUser.email
 * || externalUser.id` when it first created a user record, and never looked at
 * `externalUser.username` — the directory login name that LDAP and NTLM both
 * pass in (`sAMAccountName` for Active Directory, the Windows account name for
 * NTLM). So every external user with an email in the directory was persisted
 * with that email as their login name. The update branch refreshed only `name`
 * and `email`, so the wrong value survived every later login.
 *
 * Nothing corrected it at runtime either, because `validateAndPersistExternalUser()`
 * returns `{ ...externalUser }` and only takes `id` from the stored record. The
 * in-memory user (and the JWT minted from it) therefore carried the correct
 * login name while `users.json` disagreed — which is why this went unnoticed:
 * it only shows up where the stored record is read. Admin > Users displays the
 * email as the account name, and opening such a user in the admin editor fails
 * validation outright, because `@` is not allowed in a username.
 *
 * The correct value was on disk the whole time, just in the wrong field:
 * `ldapData.username` / `ntlmData.subject`. This migration moves it into
 * `username`.
 *
 * Conservative on purpose — a record is only rewritten when all of these hold:
 *
 * - its current `username` is an email address (contains `@`), i.e. it still
 *   looks like the value the old create path produced;
 * - a login name is recoverable from the provider block;
 * - that login name is not itself an email address;
 * - the account does not also authenticate locally, where `username` is a
 *   credential the user types rather than a directory value;
 * - no other user already holds that login name, so the rewrite cannot
 *   introduce a collision.
 *
 * Users whose `username` was already a login name, who were edited by hand, or
 * who came from a provider that supplies no login name (proxy, Teams, most
 * OIDC) are left alone.
 */

export const version = '117';
export const description = 'Backfill directory login names onto external user records';

/** Auth methods whose provider block carries a directory login name. */
const DIRECTORY_AUTH_METHODS = ['ldap', 'ntlm'];

/**
 * Does this value look like an email address rather than a login name?
 * @param {*} value
 * @returns {boolean}
 */
function looksLikeEmail(value) {
  return typeof value === 'string' && value.includes('@');
}

/**
 * Recover the directory login name from a user's provider block.
 *
 * `ldapData.username` is the login the user actually typed, so it is preferred.
 * `subject` is the normalized id (`uid || sAMAccountName || cn`), which is the
 * same value in practice and the only one NTLM records.
 *
 * @param {Object} user - A record from users.json
 * @returns {string|null} Login name, or null when none is recoverable
 */
export function recoverLoginName(user) {
  const methods = Array.isArray(user?.authMethods) ? user.authMethods : [];

  for (const method of DIRECTORY_AUTH_METHODS) {
    if (!methods.includes(method)) continue;

    const data = user[`${method}Data`];
    if (!data || typeof data !== 'object') continue;

    for (const candidate of [data.username, data.subject]) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      // A subject that is itself an email is the same bad value under a
      // different key, not a recovery.
      if (trimmed !== '' && !looksLikeEmail(trimmed)) return trimmed;
    }
  }

  return null;
}

/**
 * Is this record one the old create path mislabelled, and safe to rewrite?
 * @param {Object} user - A record from users.json
 * @returns {boolean}
 */
export function needsLoginNameBackfill(user) {
  if (!user || typeof user !== 'object') return false;

  // Only records still carrying an email as their login name.
  if (!looksLikeEmail(user.username)) return false;

  // Local auth makes `username` a credential the user types. Rewriting it
  // would change how they sign in, which is not this migration's business.
  const methods = Array.isArray(user.authMethods) ? user.authMethods : [];
  if (methods.includes('local')) return false;

  return recoverLoginName(user) !== null;
}

/**
 * Where users.json lives, relative to the contents directory.
 *
 * `platform.localAuth.usersFile` may relocate it, and the configured value is
 * written relative to the repository root (`contents/config/users.json`), while
 * migration paths are relative to the contents directory. A path pointing
 * outside contents cannot be reached from here, so it yields null and the
 * migration reports that instead of silently doing nothing.
 *
 * @param {Object} ctx - Migration context
 * @returns {Promise<string|null>} Contents-relative path, or null when unreachable
 */
async function resolveUsersFilePath(ctx) {
  const fallback = 'config/users.json';

  if (!(await ctx.fileExists('config/platform.json'))) return fallback;

  let configured;
  try {
    const platform = await ctx.readJson('config/platform.json');
    configured = platform?.localAuth?.usersFile;
  } catch {
    return fallback;
  }

  if (typeof configured !== 'string' || configured.trim() === '') return fallback;

  const normalized = configured.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('contents/')) return normalized.slice('contents/'.length);
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

export async function precondition(ctx) {
  const usersFile = await resolveUsersFilePath(ctx);
  return usersFile !== null && (await ctx.fileExists(usersFile));
}

export async function up(ctx) {
  const usersFile = await resolveUsersFilePath(ctx);

  if (usersFile === null) {
    ctx.warn(
      'localAuth.usersFile points outside the contents directory, which migrations cannot ' +
        'reach. External user records still carrying an email as their login name were not ' +
        'backfilled; they heal on the next login now that the login name is persisted.'
    );
    return;
  }

  const usersConfig = await ctx.readJson(usersFile);
  const users = usersConfig?.users;

  if (!users || typeof users !== 'object') {
    ctx.log('users.json holds no users object; nothing to backfill');
    return;
  }

  // Every login name currently in use, so a rewrite cannot collide with a
  // record this migration is not touching (or one it already rewrote).
  const takenLoginNames = new Set(
    Object.values(users)
      .map(user => (typeof user?.username === 'string' ? user.username.toLowerCase() : null))
      .filter(Boolean)
  );

  const rewritten = [];
  const skippedForCollision = [];

  for (const [userId, user] of Object.entries(users)) {
    if (!needsLoginNameBackfill(user)) continue;

    const loginName = recoverLoginName(user);
    const key = loginName.toLowerCase();

    if (takenLoginNames.has(key)) {
      skippedForCollision.push({ userId, loginName });
      continue;
    }

    takenLoginNames.delete(user.username.toLowerCase());
    takenLoginNames.add(key);

    rewritten.push({ userId, from: user.username, to: loginName });
    user.username = loginName;
  }

  if (rewritten.length === 0 && skippedForCollision.length === 0) {
    ctx.log('No external user records carry an email as their login name; nothing to backfill');
    return;
  }

  if (rewritten.length > 0) {
    await ctx.writeJson(usersFile, usersConfig);
    ctx.log(
      `Backfilled the directory login name on ${rewritten.length} external user record(s): ` +
        rewritten.map(entry => `${entry.from} -> ${entry.to}`).join(', ')
    );
  }

  if (skippedForCollision.length > 0) {
    ctx.warn(
      `Left ${skippedForCollision.length} user record(s) on their email login name because ` +
        'another user already holds the recovered directory login name. Resolve the duplicate ' +
        'accounts in Admin > Users: ' +
        skippedForCollision.map(entry => `${entry.userId} (${entry.loginName})`).join(', ')
    );
  }
}
