/**
 * The admin is warned while the login page lists the demo accounts and the
 * credentials it prints still sign in (utils/demoAccounts.js): the account is
 * looked up the way local sign-in does it and the printed password is checked
 * against its stored hash.
 */
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({}),
    get: () => ({ data: null, etag: null }),
    setCacheEntry: () => {}
  }
}));

const { getDemoAccountStatus } = await import('../utils/demoAccounts.js');
const { hashPasswordWithUserId } = await import('../utils/userManager.js');

const shippedUsersFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'defaults',
  'config',
  'users.json'
);

let testDir;
let usersFile;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-accounts-test-'));
  usersFile = path.join(testDir, 'users.json');
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function writeUsers(change = users => users) {
  const shipped = JSON.parse(await fs.readFile(shippedUsersFile, 'utf8'));
  await fs.writeFile(usersFile, JSON.stringify({ ...shipped, users: change(shipped.users) }));
}

const localAuth = extra => ({ enabled: true, usersFile, ...extra });

describe('demo account warning', () => {
  test('warns while the demo accounts are listed and keep the shipped password', async () => {
    await writeUsers();
    expect(await getDemoAccountStatus(localAuth({ showDemoAccounts: true }))).toEqual({
      showDemoAccounts: true,
      accounts: ['admin', 'user'],
      warn: true
    });
  });

  test('treats a missing showDemoAccounts as on, as the login page does', async () => {
    await writeUsers();
    expect((await getDemoAccountStatus(localAuth())).warn).toBe(true);
  });

  test('does not warn once the login page no longer lists them', async () => {
    await writeUsers();
    expect(await getDemoAccountStatus(localAuth({ showDemoAccounts: false }))).toMatchObject({
      showDemoAccounts: false,
      warn: false
    });
    expect((await getDemoAccountStatus({ usersFile, enabled: false })).warn).toBe(false);
  });

  test('leaves out accounts whose password was changed or that are disabled', async () => {
    await writeUsers(users => ({
      ...users,
      user_demo_admin: { ...users.user_demo_admin, passwordHash: '$2b$12$changed' },
      user_demo_user: { ...users.user_demo_user, active: false }
    }));
    expect(await getDemoAccountStatus(localAuth({ showDemoAccounts: true }))).toEqual({
      showDemoAccounts: true,
      accounts: [],
      warn: false
    });
  });

  test('still warns when the shipped password was saved again with a new salt', async () => {
    const passwordHash = await hashPasswordWithUserId('password123', 'user_demo_admin');
    await writeUsers(users => ({
      ...users,
      user_demo_admin: { ...users.user_demo_admin, passwordHash }
    }));
    expect((await getDemoAccountStatus(localAuth({ showDemoAccounts: true }))).accounts).toContain(
      'admin'
    );
  });

  test('checks whichever account answers to the printed username', async () => {
    const passwordHash = await hashPasswordWithUserId('password123', 'user_custom');
    await writeUsers(() => ({
      user_custom: { id: 'user_custom', username: 'Admin', active: true, passwordHash }
    }));
    expect((await getDemoAccountStatus(localAuth({ showDemoAccounts: true }))).accounts).toEqual([
      'admin'
    ]);
  });

  test('names only the accounts that still have the shipped password', async () => {
    await writeUsers(users => ({
      ...users,
      user_demo_user: { ...users.user_demo_user, passwordHash: '$2b$12$changed' }
    }));
    expect((await getDemoAccountStatus(localAuth({ showDemoAccounts: true }))).accounts).toEqual([
      'admin'
    ]);
  });
});
