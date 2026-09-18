#!/usr/bin/env node

/**
 * Migration V112 specs — grandfathering.
 *
 * V111 turns the approval gate on. This migration is the only reason that is
 * safe to ship: it approves exactly the client-metadata clients an
 * installation's users are already connected through, so an upgrade
 * disconnects nobody — and creates nothing for any other client, because those
 * are precisely the ones that should have to be approved.
 *
 * The record it writes is policy only. No `client_name`, no `redirect_uris`,
 * no `grant_types`: identity keeps coming from the document on every request.
 * And it never overwrites a record that exists, so a client an administrator
 * blocked before upgrading is not found approved afterwards.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  up,
  precondition,
  version,
  description
} from '../migrations/V112__grandfather_connected_cimd_clients.js';

const CODE_URL = 'https://claude.ai/oauth/claude-code-client-metadata';
const WEB_URL = 'https://claude.ai/oauth/claude-web-client-metadata';

let baseDir;

/** A migration context over a scratch contents directory. */
function makeCtx(dir) {
  const logs = [];
  return {
    logs,
    fileExists: async rel =>
      fs
        .stat(path.join(dir, rel))
        .then(() => true)
        .catch(() => false),
    readJson: async rel =>
      fs
        .readFile(path.join(dir, rel), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), JSON.stringify(data, null, 2), 'utf8');
    },
    log: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m])
  };
}

async function seed(dir, { consents = {}, clients = {} } = {}) {
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'data/oauth-consent.json'),
    JSON.stringify({ consents }, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(dir, 'config/oauth-clients.json'),
    JSON.stringify({ clients, metadata: { version: '1.0.0' } }, null, 2),
    'utf8'
  );
}

const consent = (clientId, userId, overrides = {}) => ({
  clientId,
  userId,
  clientKind: 'cimd',
  clientName: 'Claude Code',
  clientHost: 'claude.ai',
  grantedAt: '2026-01-02T00:00:00.000Z',
  scopes: ['openid'],
  ...overrides
});

describe('V112 — grandfather connected CIMD clients', () => {
  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v112-'));
  });
  after(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('declares its version and description', () => {
    assert.equal(version, '112');
    assert.equal(description, 'Approve client-metadata clients that already have connections');
  });

  it('skips when there is no consent store to read', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'nofile-'));
    assert.equal(await precondition(makeCtx(dir)), false);
  });

  it('approves exactly the clients with a connection, and creates nothing else', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'approve-'));
    await seed(dir, {
      consents: {
        [`${CODE_URL}:alice`]: consent(CODE_URL, 'alice'),
        [`${CODE_URL}:bob`]: consent(CODE_URL, 'bob', {
          grantedAt: '2025-11-01T00:00:00.000Z'
        }),
        // A stored client is not a CIMD client and gets no record here.
        'client_reporting_a1b2:carol': consent('client_reporting_a1b2', 'carol', {
          clientKind: 'stored'
        })
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { clients } = await ctx.readJson('config/oauth-clients.json');
    assert.deepEqual(Object.keys(clients), [CODE_URL]);

    const record = clients[CODE_URL];
    assert.equal(record.approvalState, 'approved');
    assert.equal(record.active, true);
    assert.equal(record.metadata.approvedBy, 'migration');
    assert.equal(record.metadata.cimd, true);
    // The earliest grant is what "first seen" means for a client that predates
    // discovery records.
    assert.equal(record.metadata.firstSeenAt, '2025-11-01T00:00:00.000Z');
    assert.equal(record.metadata.displayName, 'Claude Code');
  });

  it('writes policy only — never identity, never a secret, never trust', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'policy-only-'));
    await seed(dir, { consents: { [`${CODE_URL}:alice`]: consent(CODE_URL, 'alice') } });
    const ctx = makeCtx(dir);
    await up(ctx);

    const record = (await ctx.readJson('config/oauth-clients.json')).clients[CODE_URL];
    assert.equal(record.name, undefined, 'the name comes from the document, not the record');
    assert.equal(record.redirectUris, undefined);
    assert.equal(record.grantTypes, undefined);
    assert.equal(record.clientSecret, null);
    assert.equal(record.trusted, false);
    assert.equal(record.consentRequired, true);
  });

  it('never overwrites a decision an administrator already made', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'blocked-'));
    await seed(dir, {
      consents: { [`${CODE_URL}:alice`]: consent(CODE_URL, 'alice') },
      clients: {
        [CODE_URL]: {
          id: CODE_URL,
          clientId: CODE_URL,
          active: false,
          approvalState: 'approved',
          metadata: { cimd: true, host: 'claude.ai' }
        }
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const record = (await ctx.readJson('config/oauth-clients.json')).clients[CODE_URL];
    assert.equal(record.active, false, 'a blocked client stays blocked across the upgrade');
  });

  it('ignores expired grants', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'expired-'));
    await seed(dir, {
      consents: {
        [`${WEB_URL}:alice`]: consent(WEB_URL, 'alice', {
          expiresAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });
    const ctx = makeCtx(dir);
    await up(ctx);

    const { clients } = await ctx.readJson('config/oauth-clients.json');
    assert.deepEqual(Object.keys(clients), []);
  });

  it('is idempotent', async () => {
    const dir = await fs.mkdtemp(path.join(baseDir, 'twice-'));
    await seed(dir, { consents: { [`${CODE_URL}:alice`]: consent(CODE_URL, 'alice') } });
    const ctx = makeCtx(dir);
    await up(ctx);
    const first = await ctx.readJson('config/oauth-clients.json');
    await up(ctx);
    assert.deepEqual(await ctx.readJson('config/oauth-clients.json'), first);
  });
});
