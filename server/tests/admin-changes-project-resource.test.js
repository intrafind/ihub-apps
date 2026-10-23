// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The change history answers for admin projects. Their snapshots are written
 * (`routes/admin/projects.js`) and the History button of the project pages
 * reads them; a resource the route did not know answered 400 for both.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let scratch;
let handlers;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-changes-'));
  process.env.CONTENTS_DIR = scratch;
  const { default: register } = await import('../routes/admin/changes.js');
  handlers = {};
  const record =
    method =>
    (routePath, ...chain) => {
      handlers[`${method} ${routePath}`] = chain.at(-1);
    };
  register({ get: record('get'), post: record('post') });
});

after(async () => {
  delete process.env.CONTENTS_DIR;
  await fs.rm(scratch, { recursive: true, force: true });
});

function call(handler, params) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
      send(body) {
        resolve({ status: this.statusCode, body });
        return this;
      }
    };
    handler({ params, user: { id: 'u', groups: ['admins'] }, query: {} }, res);
  });
}

describe('change history of admin projects', () => {
  it('lists the snapshots of a project instead of answering 400', async () => {
    const listPath = Object.keys(handlers).find(
      key => key.startsWith('get ') && !key.includes(':filename')
    );
    assert.ok(listPath, 'the list route is registered');
    const ok = await call(handlers[listPath], { resource: 'project', id: 'faq' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, []);
    const unknown = await call(handlers[listPath], { resource: 'nonsense', id: 'faq' });
    assert.equal(unknown.status, 400);
  });
});
