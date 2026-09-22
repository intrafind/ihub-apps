import path from 'path';
import { jest } from '@jest/globals';

/**
 * `locateConfigFile` decides where a path-configured configuration file is
 * read from, written to, and cached under. Two settings name a file this way —
 * `localAuth.usersFile` and `oauth.clientsFile` — and the three answers have to
 * agree: `configStore.writeJson` resolves every relative path under
 * `contents/`, so a file judged contained that is not one gets written to a
 * different place than it is read from, and the divergence only shows up after
 * a restart, once the cache that was papering over it is cold.
 */

const ROOT = path.join(path.sep, 'srv', 'ihub');

jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(require('path').sep, 'srv', 'ihub')
}));
// A getter rather than a value: one test renames the contents directory, and
// `jest.mock` factories are hoisted above every binding in the file, so the
// only thing they can close over is a global.
jest.mock('../../../server/config.js', () => ({
  __esModule: true,
  default: {
    get CONTENTS_DIR() {
      return global.__configFileLocationContentsDir || 'contents';
    }
  }
}));

import { locateConfigFile } from '../../../server/utils/configFileLocation.js';

beforeEach(() => {
  global.__configFileLocationContentsDir = 'contents';
});
afterAll(() => {
  delete global.__configFileLocationContentsDir;
});

test('the default users file is addressed by the key the store and the preload share', () => {
  const located = locateConfigFile('contents/config/users.json');
  expect(located.fullPath).toBe(path.join(ROOT, 'contents', 'config', 'users.json'));
  expect(located.cacheKey).toBe('config/users.json');
  expect(located.relPath).toBe('config/users.json');
});

test('a relative path outside contents/ is not written into contents/', () => {
  // The regression: containment used to be tested against the installation
  // root, so this was judged contained, `writeJson` resolved it under
  // `contents/`, and the file went on being read from the root. An account
  // created before a restart was simply gone after it.
  const located = locateConfigFile('secrets/users.json');
  expect(located.fullPath).toBe(path.join(ROOT, 'secrets', 'users.json'));
  expect(located.relPath).toBeNull();
  expect(located.cacheKey).toBe('secrets/users.json');
});

test('an absolute path outside the installation is left where it is', () => {
  const outside = path.join(path.sep, 'run', 'secrets', 'users.json');
  const located = locateConfigFile(outside);
  expect(located.fullPath).toBe(outside);
  expect(located.relPath).toBeNull();
});

test('an absolute path inside contents/ is still served by the store', () => {
  const inside = path.join(ROOT, 'contents', 'config', 'users.json');
  const located = locateConfigFile(inside);
  expect(located.relPath).toBe('config/users.json');
  expect(located.cacheKey).toBe('config/users.json');
});

test('CONTENTS_DIR decides what contained means, not the literal prefix', () => {
  // An installation that renamed its contents directory used to be told that
  // `contents/config/users.json` was inside it, purely on the string prefix —
  // and the write then landed in `<CONTENTS_DIR>/config/users.json`, which is
  // a different file again.
  global.__configFileLocationContentsDir = 'mydata';

  expect(locateConfigFile('contents/config/users.json').relPath).toBeNull();
  expect(locateConfigFile('mydata/config/users.json').relPath).toBe('config/users.json');
});

test('a nested file under contents/ keeps its whole relative path', () => {
  const located = locateConfigFile('contents/auth/clients/oauth-clients.json');
  expect(located.relPath).toBe('auth/clients/oauth-clients.json');
  expect(located.cacheKey).toBe('auth/clients/oauth-clients.json');
});
