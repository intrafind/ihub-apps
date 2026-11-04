// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V216: complete the default chain admins → users → authenticated → anonymous. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { up, precondition } from '../migrations/V216__default_group_inheritance_chain.js';

function makeCtx(groups) {
  const files = { 'config/groups.json': { groups } };
  let writes = 0;
  return {
    files,
    get writes() {
      return writes;
    },
    fileExists: async rel => rel in files,
    readJson: async rel => structuredClone(files[rel]),
    writeJson: async (rel, data) => {
      writes += 1;
      files[rel] = structuredClone(data);
    },
    log: () => {},
    warn: () => {}
  };
}

const inheritsOf = ctx => id => ctx.files['config/groups.json'].groups[id].inherits;

describe('V216 default group inheritance chain', () => {
  it('adds the missing links', async () => {
    const ctx = makeCtx({
      admins: {},
      users: {},
      authenticated: { inherits: ['anonymous'] },
      anonymous: {}
    });
    assert.equal(await precondition(ctx), true);
    await up(ctx);
    const of = inheritsOf(ctx);
    assert.deepEqual(of('users'), ['authenticated']);
    assert.deepEqual(of('admins'), ['users']);
    assert.deepEqual(of('authenticated'), ['anonymous']);
  });

  it('keeps an existing inherits, even an empty one', async () => {
    const ctx = makeCtx({
      admins: { inherits: [] },
      users: { inherits: ['anonymous'] },
      authenticated: {},
      anonymous: {}
    });
    await up(ctx);
    assert.equal(ctx.writes, 0);
    assert.deepEqual(inheritsOf(ctx)('admins'), []);
    assert.deepEqual(inheritsOf(ctx)('users'), ['anonymous']);
  });

  it('skips a link that would create a cycle', async () => {
    const ctx = makeCtx({
      admins: {},
      users: {},
      authenticated: { inherits: ['users'] }
    });
    await up(ctx);
    assert.equal(inheritsOf(ctx)('users'), undefined);
    assert.deepEqual(inheritsOf(ctx)('admins'), ['users']);
  });

  it('is idempotent and ignores missing groups', async () => {
    const ctx = makeCtx({ users: {}, authenticated: {} });
    await up(ctx);
    await up(ctx);
    assert.deepEqual(inheritsOf(ctx)('users'), ['authenticated']);
    assert.equal(ctx.writes, 1);
  });
});
