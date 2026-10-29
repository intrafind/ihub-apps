// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

// Plain-node test (node server/tests/iFinderTokenExchangeCluster.test.js).
//
// Exchanged iFinder tokens are cached per worker. Revoking (or deactivating)
// on one worker must stop the user's iFinder access on every worker, not leave
// the others serving their cached token until it expires. Forks real workers,
// like clusterBus.test.js; the mock token endpoint runs in the primary.

import assert from 'assert';
import cluster from 'node:cluster';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) {
  delete process.env[name];
}

if (cluster.isPrimary) {
  await runPrimary();
} else {
  await runWorker();
}

async function runPrimary() {
  const { initPrimaryBus } = await import('../clusterBus.js');
  let exchanges = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      exchanges += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `ifinder-${exchanges}`, expires_in: 3600 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-ifinder-cluster-'));
  const env = {
    TEST_TOKEN_URL: `http://127.0.0.1:${server.address().port}/token`,
    TEST_STORAGE_DIR: storageDir,
    TEST_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex')
  };

  const workers = [];
  initPrimaryBus({ getWorkers: () => workers });
  for (let i = 0; i < 2; i++) workers.push(cluster.fork(env));

  const pending = new Map();
  let nextId = 1;
  for (const worker of workers) {
    worker.on('message', msg => {
      if (!msg?.testReply) return;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
  }
  const ask = (worker, request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no answer to ${request.step}`)), 5000);
      pending.set(id, msg => {
        clearTimeout(timer);
        resolve(msg);
      });
      worker.send({ ...request, id });
    });

  let failed = false;
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`✅ ${label}`);
    } catch (error) {
      failed = true;
      console.error(`❌ ${label}\n   ${error.message}`);
    }
  };

  await Promise.all(workers.map(w => new Promise(r => w.once('online', r))));
  await Promise.all(workers.map(w => ask(w, { step: 'ready' })));
  const [a, b] = workers;

  await check('each worker exchanges once and then serves its cached token', async () => {
    await ask(a, { step: 'signIn' });
    const first = await ask(b, { step: 'header' });
    assert.strictEqual(first.header, 'Bearer ifinder-1');
    assert.strictEqual((await ask(b, { step: 'header' })).header, 'Bearer ifinder-1');
    assert.strictEqual((await ask(a, { step: 'header' })).header, 'Bearer ifinder-2');
    assert.strictEqual(exchanges, 2);
  });

  await check('a revoke on one worker ends the cached token on the other', async () => {
    await ask(a, { step: 'revoke' });
    // The broadcast goes through the primary; give it a moment to arrive.
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = await ask(b, { step: 'header' });
    assert.strictEqual(after.header, undefined, `worker b still answered ${after.header}`);
    assert.strictEqual(after.code, 'ifinder_reauthorization_required');
  });

  for (const worker of workers) worker.kill();
  server.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
  if (failed) {
    console.error('\n❌ iFinder token exchange cluster tests failed');
    process.exit(1);
  }
  console.log('\niFinderTokenExchangeCluster: all checks passed');
  process.exit(0);
}

async function runWorker() {
  const { initWorkerBus } = await import('../clusterBus.js');
  initWorkerBus();
  const { default: configCache } = await import('../configCache.js');
  const { default: tokenStorageService } = await import('../services/TokenStorageService.js');
  const { default: credentialService } = await import('../services/CredentialService.js');
  const provider = await import('../services/integrations/iFinderTokenProvider.js');

  tokenStorageService.storageBasePath = process.env.TEST_STORAGE_DIR;
  tokenStorageService.encryptionKey = process.env.TEST_ENCRYPTION_KEY;
  credentialService.tryResolveSecret = () => 'secret';
  const platform = {
    proxy: { enabled: false },
    oidcAuth: {
      enabled: true,
      providers: [
        {
          name: 'zitadel',
          displayName: 'Zitadel',
          clientId: 'ihub',
          clientSecretRef: 'ref',
          tokenURL: process.env.TEST_TOKEN_URL
        }
      ]
    },
    iFinder: {
      enabled: true,
      defaultScope: 'fa_index_read',
      authMode: 'oidcTokenExchange',
      tokenExchange: { oidcProvider: 'zitadel', audience: 'ifinder' }
    }
  };
  configCache.getPlatform = () => platform;
  const user = { id: 'alice', authMode: 'oidc', provider: 'zitadel' };

  process.on('message', async msg => {
    if (!msg?.step) return;
    const reply = extra => process.send({ testReply: true, id: msg.id, ...extra });
    try {
      switch (msg.step) {
        case 'signIn':
          await provider.storeLoginTokens(user.id, 'zitadel', {
            accessToken: 'login-at',
            refreshToken: 'rt',
            expiresIn: 3600
          });
          return reply({});
        case 'header':
          return reply({ header: await provider.getAuthorizationHeader(user) });
        case 'revoke':
          await provider.deleteLoginTokens(user.id);
          return reply({});
        default:
          return reply({});
      }
    } catch (error) {
      return reply({ code: error.code, message: error.message });
    }
  });
}
