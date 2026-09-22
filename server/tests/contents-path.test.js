/**
 * Specs for utils/contentsPath — every path under the contents directory
 * follows `CONTENTS_DIR`, including the fallbacks for the two settings that
 * name a file relative to the installation root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Evaluate the helpers in a fresh process, where `CONTENTS_DIR` is read at boot. */
function helpersWith(contentsDir) {
  const script = `
    import * as h from './utils/contentsPath.js';
    import { getRootDir } from './pathUtils.js';
    console.log(JSON.stringify({
      root: getRootDir(),
      contents: h.getContentsPath(),
      platform: h.getContentsPath('config', 'platform.json'),
      relative: h.contentsRelativePath('config', 'users.json'),
      clientsDefault: h.oauthClientsFile({}),
      clientsMissingSection: h.oauthClientsFile(undefined),
      clientsConfigured: h.oauthClientsFile({ clientsFile: '/run/secrets/clients.json' }),
      usersDefault: h.localUsersFile({ enabled: true }),
      usersConfigured: h.localUsersFile({ usersFile: 'elsewhere/users.json' })
    }));
  `;
  const env = { ...process.env };
  if (contentsDir === undefined) delete env.CONTENTS_DIR;
  else env.CONTENTS_DIR = contentsDir;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: serverDir,
    env
  });
  return JSON.parse(out.toString().trim().split('\n').pop());
}

test('the default contents directory is `contents` under the installation root', () => {
  const r = helpersWith(undefined);
  assert.equal(r.contents, path.join(r.root, 'contents'));
  assert.equal(r.platform, path.join(r.root, 'contents', 'config', 'platform.json'));
  assert.equal(r.relative, 'contents/config/users.json');
  assert.equal(r.clientsDefault, 'contents/config/oauth-clients.json');
  assert.equal(r.usersDefault, 'contents/config/users.json');
});

test('a custom CONTENTS_DIR moves every path and both fallbacks', () => {
  const r = helpersWith('custom-contents');
  assert.equal(r.contents, path.join(r.root, 'custom-contents'));
  assert.equal(r.platform, path.join(r.root, 'custom-contents', 'config', 'platform.json'));
  assert.equal(r.relative, 'custom-contents/config/users.json');
  assert.equal(r.clientsDefault, 'custom-contents/config/oauth-clients.json');
  assert.equal(r.clientsMissingSection, 'custom-contents/config/oauth-clients.json');
  assert.equal(r.usersDefault, 'custom-contents/config/users.json');
});

test('a nested CONTENTS_DIR stays root-relative and `/`-separated', () => {
  const r = helpersWith(path.join('deploy', 'contents'));
  assert.equal(r.relative, 'deploy/contents/config/users.json');
});

test('a configured path wins over the fallback', () => {
  const r = helpersWith('custom-contents');
  assert.equal(r.clientsConfigured, '/run/secrets/clients.json');
  assert.equal(r.usersConfigured, 'elsewhere/users.json');
});
