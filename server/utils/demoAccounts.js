/**
 * The demo accounts that ship in `server/defaults/config/users.json` (`admin`
 * and `user`, whose passwords are documented), and whether this installation
 * still has them with the shipped password.
 *
 * "Shipped password" means the stored hash is the shipped hash, character for
 * character. No password is checked: a password that was set again, even to
 * the same value, gets a new salt and no longer matches.
 *
 * @module utils/demoAccounts
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import { loadUsers } from './userManager.js';
import { localUsersFile } from './contentsPath.js';

/** The shipped accounts, read once: `[{ id, passwordHash }]`. */
let shippedAccounts = null;

/**
 * @returns {Promise<Array<{id: string, passwordHash: string}>>}
 */
async function getShippedAccounts() {
  if (!shippedAccounts) {
    shippedAccounts = fs
      .readFile(path.join(getRootDir(), 'server', 'defaults', 'config', 'users.json'), 'utf8')
      .then(text =>
        Object.values(JSON.parse(text).users || {})
          .filter(user => user.id && user.passwordHash)
          .map(({ id, passwordHash }) => ({ id, passwordHash }))
      )
      .catch(() => []);
  }
  return shippedAccounts;
}

/**
 * Usernames of active shipped demo accounts that still have the shipped password.
 *
 * @param {object} [localAuthConfig] - `platform.localAuth`
 * @returns {Promise<string[]>}
 */
export async function demoAccountsWithShippedPassword(localAuthConfig) {
  const shipped = await getShippedAccounts();
  const users = Object.values(loadUsers(localUsersFile(localAuthConfig)).users || {});
  return shipped
    .map(({ id, passwordHash }) =>
      users.find(user => user.id === id && user.passwordHash === passwordHash)
    )
    .filter(user => user && user.active !== false)
    .map(user => user.username || user.id);
}

/**
 * Whether the admin should be warned: local sign-in is on, the login page lists
 * the demo accounts (`localAuth.showDemoAccounts`, on unless set to false), and
 * at least one of them still has the shipped password.
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
