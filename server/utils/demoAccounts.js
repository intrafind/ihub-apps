/**
 * Whether the demo credentials the login page prints still sign in.
 *
 * With `localAuth.showDemoAccounts` on, the login page lists `admin` and `user`
 * with the password they ship with (client/src/features/auth/components/
 * LoginForm.jsx and the auth gate). This checks each of those credentials the
 * way local sign-in would: find the account by username or email and verify
 * the password against its stored hash. A password that was set again to the
 * same value therefore still counts.
 *
 * Results are cached per stored hash, so the bcrypt cost is paid once after
 * each password change rather than on every check.
 *
 * @module utils/demoAccounts
 */
import { equalsIgnoreCase, loadUsers } from './userManager.js';
import { localUsersFile } from './contentsPath.js';
import { verifyPasswordWithUserId } from '../middleware/localAuth.js';

/** The credentials the login page prints when `showDemoAccounts` is on. */
export const DEMO_CREDENTIALS = Object.freeze([
  Object.freeze({ username: 'admin', password: 'password123' }),
  Object.freeze({ username: 'user', password: 'password123' })
]);

/** `${userId}:${passwordHash}:${password}` -> whether the password matches. */
const verified = new Map();

/**
 * Whether `password` is `user`'s password, cached per stored hash.
 *
 * @param {{id: string, passwordHash: string}} user
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function matches(user, password) {
  const cacheKey = `${user.id}:${user.passwordHash}:${password}`;
  if (!verified.has(cacheKey)) {
    verified.set(
      cacheKey,
      verifyPasswordWithUserId(password, user.id, user.passwordHash).catch(() => false)
    );
  }
  return verified.get(cacheKey);
}

/**
 * Usernames of the printed demo credentials that still sign in.
 *
 * @param {object} [localAuthConfig] - `platform.localAuth`
 * @returns {Promise<string[]>}
 */
export async function demoAccountsWithShippedPassword(localAuthConfig) {
  const users = Object.values(loadUsers(localUsersFile(localAuthConfig)).users || {});
  const found = await Promise.all(
    DEMO_CREDENTIALS.map(async ({ username, password }) => {
      // The same lookup as loginUser: username or email, case-insensitive.
      const user = users.find(
        u => equalsIgnoreCase(u.username, username) || equalsIgnoreCase(u.email, username)
      );
      if (!user || user.active === false || !user.passwordHash) return null;
      return (await matches(user, password)) ? username : null;
    })
  );
  return found.filter(Boolean);
}

/**
 * Whether the admin should be warned: local sign-in is on, the login page lists
 * the demo accounts (`localAuth.showDemoAccounts`, on unless set to false), and
 * at least one printed credential still signs in.
 *
 * @param {object} [localAuthConfig] - `platform.localAuth`
 * @returns {Promise<{showDemoAccounts: boolean, accounts: string[], warn: boolean}>}
 */
export async function getDemoAccountStatus(localAuthConfig = {}) {
  const showDemoAccounts =
    localAuthConfig.enabled === true && localAuthConfig.showDemoAccounts !== false;
  const accounts = await demoAccountsWithShippedPassword(localAuthConfig);
  return { showDemoAccounts, accounts, warn: showDemoAccounts && accounts.length > 0 };
}
