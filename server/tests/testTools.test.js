// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The test-only tools `e2e_counter_write` and `e2e_counter_read`
 * (`services/integrations/protocols/native/connectors/testTools.js`): they are
 * registered only in a server started for a test, and they reach the counter
 * of the test through `httpFetch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TEST_TOOLS_ARMED,
  TEST_TOOLS_CONNECTOR_ID,
  TEST_TOOL_IDS,
  createTestToolsConnector,
  registerTestTools,
  testToolsArmed
} from '../services/integrations/protocols/native/connectors/testTools.js';
import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';
import configCache from '../configCache.js';
import { createCounter, startCounter } from '../../tests/config/test-counter.mjs';
import {
  COUNTER_READ,
  COUNTER_WRITE,
  TEST_TOOLS_DEFINITION,
  TEST_TOOLS_INSTALLATION,
  seedTestTools
} from '../../tests/config/test-tools-contents.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectorsDir = path.join(serverDir, 'services/integrations/protocols/native/connectors');

test('the tools are switched on only with NODE_ENV=test and IHUB_TEST_TOOLS=1', () => {
  assert.equal(testToolsArmed({ NODE_ENV: 'test', IHUB_TEST_TOOLS: '1' }), true);
  for (const env of [
    {},
    { NODE_ENV: 'test' },
    { IHUB_TEST_TOOLS: '1' },
    { NODE_ENV: 'production', IHUB_TEST_TOOLS: '1' },
    { NODE_ENV: 'development', IHUB_TEST_TOOLS: '1' },
    { NODE_ENV: 'test', IHUB_TEST_TOOLS: 'true' },
    { NODE_ENV: 'test', IHUB_TEST_TOOLS: '0' }
  ]) {
    assert.equal(testToolsArmed(env), false, JSON.stringify(env));
  }
  // This test process runs with NODE_ENV=test and without the switch.
  assert.equal(TEST_TOOLS_ARMED, false);
});

test('registerTestTools registers nothing and warns nothing unless switched on', () => {
  const registered = [];
  const warned = [];
  const warn = (message, meta) => warned.push([message, meta]);

  assert.equal(
    registerTestTools(connector => registered.push(connector), { armed: false, warn }),
    false
  );
  assert.deepEqual(registered, []);
  assert.deepEqual(warned, []);

  assert.equal(
    registerTestTools(connector => registered.push(connector), { armed: true, warn }),
    true
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, TEST_TOOLS_CONNECTOR_ID);
  assert.deepEqual(Object.keys(registered[0].actions), [...TEST_TOOL_IDS]);
  assert.equal(warned.length, 1, 'one warning line when the tools are registered');
  assert.match(warned[0][0], /TEST ONLY.*e2e_counter_write.*e2e_counter_read/);
});

test('the write tool posts to the counter and the read tool reads it, through the fetch it was given', async t => {
  const counter = await startCounter();
  t.after(() => counter.close());
  const calls = [];
  const connector = createTestToolsConnector({
    counterUrl: `${counter.url}/`,
    fetch: (url, init) => {
      calls.push([init.method, url]);
      return fetch(url, init);
    },
    killPoint: () => {}
  });

  assert.deepEqual(await connector.actions.e2e_counter_write.run({ key: 'order-1' }), {
    key: 'order-1',
    count: 1
  });
  assert.deepEqual(
    await connector.actions.e2e_counter_write.run({ key: 'order-1', value: 'second' }),
    { key: 'order-1', count: 2 }
  );
  assert.deepEqual(await connector.actions.e2e_counter_read.run({ key: 'order-1' }), {
    key: 'order-1',
    count: 2,
    values: ['second']
  });
  assert.deepEqual(await connector.actions.e2e_counter_read.run({ key: 'never-written' }), {
    key: 'never-written',
    count: 0,
    values: []
  });
  assert.deepEqual(calls, [
    ['POST', `${counter.url}/count/order-1`],
    ['POST', `${counter.url}/count/order-1`],
    ['GET', `${counter.url}/count/order-1`],
    ['GET', `${counter.url}/count/never-written`]
  ]);
  assert.deepEqual(counter.counter.snapshot(), {
    total: 2,
    counters: { 'order-1': { count: 2, values: ['second'] } }
  });
});

test('without a fetch of its own the connector uses the HTTP client of the server', async t => {
  const counter = await startCounter();
  t.after(() => counter.close());
  const connector = createTestToolsConnector({ counterUrl: counter.url, killPoint: () => {} });
  assert.deepEqual(await connector.actions.e2e_counter_write.run({ key: 'default-client' }), {
    key: 'default-client',
    count: 1
  });
  // No other way out of the server is written in the module.
  const source = fs.readFileSync(path.join(connectorsDir, 'testTools.js'), 'utf8');
  assert.match(source, /import \{ httpFetch \} from '.*utils\/httpConfig\.js';/);
  assert.doesNotMatch(source, /globalThis\.fetch|node:https?|undici|WebSocket/);
});

/** `openssl` by its full path in a system directory, never through PATH; null when absent. */
const OPENSSL =
  ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl'].find(candidate =>
    fs.existsSync(candidate)
  ) || null;

test(
  'a counter behind a self-signed certificate is reached only when its host is whitelisted',
  { skip: OPENSSL ? false : 'openssl is not installed in a system directory' },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-test-tools-tls-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    const made = spawnSync(
      OPENSSL,
      [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'],
        ...['-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1'],
        ...['-addext', 'subjectAltName=IP:127.0.0.1']
      ],
      { encoding: 'utf8' }
    );
    assert.equal(made.status, 0, made.stderr);
    const counter = createCounter();
    const server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (req, res) => {
        counter.handle(req, res).catch(() => res.destroy());
      }
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      configCache.setCacheEntry('config/platform.json', {});
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const connector = createTestToolsConnector({
      counterUrl: `https://127.0.0.1:${server.address().port}`,
      killPoint: () => {}
    });
    const write = () => connector.actions.e2e_counter_write.run({ key: 'tls' });

    // Not whitelisted: the certificate is checked, and the call fails.
    configCache.setCacheEntry('config/platform.json', {
      ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['other.example'] }
    });
    await assert.rejects(write());
    assert.equal(counter.count('tls'), 0);

    // Whitelisted: the same call goes through.
    configCache.setCacheEntry('config/platform.json', {
      ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['127.0.0.1'] }
    });
    assert.deepEqual(await write(), { key: 'tls', count: 1 });

    // Whitelisted, with the switch off: checked again.
    configCache.setCacheEntry('config/platform.json', {
      ssl: { ignoreInvalidCertificates: false, domainWhitelist: ['127.0.0.1'] }
    });
    await assert.rejects(write());
    assert.equal(counter.count('tls'), 1);
  }
);

test('the write tool passes its two kill points around the write, in that order', async () => {
  const order = [];
  const connector = createTestToolsConnector({
    counterUrl: 'test://counter',
    fetch: async () => {
      order.push('write');
      return { ok: true, status: 200, json: async () => ({ count: 1 }) };
    },
    killPoint: name => order.push(name)
  });
  await connector.actions.e2e_counter_write.run({ key: 'k' });
  assert.deepEqual(order, ['e2e-counter-before-write', 'write', 'e2e-counter-after-write']);

  // A read passes none.
  order.length = 0;
  await connector.actions.e2e_counter_read.run({ key: 'k' });
  assert.deepEqual(order, ['write']);
});

test('a key that is not a plain name, a missing counter and a failing counter are errors', async () => {
  let fetched = 0;
  const connector = createTestToolsConnector({
    counterUrl: 'test://counter',
    fetch: async () => {
      fetched += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    },
    killPoint: () => {}
  });
  for (const key of [undefined, '', '../x', 'a/b', 'a b', 'x'.repeat(65), 7]) {
    await assert.rejects(connector.actions.e2e_counter_write.run({ key }), /key must be/);
    await assert.rejects(connector.actions.e2e_counter_read.run({ key }), /key must be/);
  }
  assert.equal(fetched, 0, 'a bad key reaches no counter');
  await assert.rejects(
    connector.actions.e2e_counter_write.run({ key: 'k' }),
    /The test counter answered 503/
  );

  const withoutCounter = createTestToolsConnector({ counterUrl: '', killPoint: () => {} });
  await assert.rejects(
    withoutCounter.actions.e2e_counter_read.run({ key: 'k' }),
    /IHUB_TEST_COUNTER_URL is not set/
  );
  assert.equal((await withoutCounter.test())[0].status, 'fail');
  assert.deepEqual(withoutCounter.status(), { connected: false, toolCount: 2 });
});

test('the read tool is declared as outside content; the write tool is not', () => {
  const connector = createTestToolsConnector({ counterUrl: 'test://counter' });
  assert.deepEqual(connector.actions.e2e_counter_read.extras(), { untrustedInput: true });
  assert.equal(connector.actions.e2e_counter_write.extras, undefined);
  assert.deepEqual(connector.actions.e2e_counter_write.parameters.required, ['key']);
  assert.deepEqual(connector.actions.e2e_counter_read.parameters.required, ['key']);
});

test('the definition a test seeds is a valid definition of these tools: write is a write, read is a read', t => {
  const contents = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-test-tools-'));
  t.after(() => fs.rmSync(contents, { recursive: true, force: true }));
  fs.mkdirSync(path.join(contents, 'config'));
  const integrationsPath = path.join(contents, 'config', 'integrations.json');
  fs.writeFileSync(
    integrationsPath,
    JSON.stringify({ installed: [{ id: 'ihub' }], security: { blockPrivateIps: true } })
  );

  seedTestTools(contents);
  seedTestTools(contents); // twice: still one installation

  const definition = JSON.parse(
    fs.readFileSync(
      path.join(contents, 'integration-definitions', 'test.ihub__e2e-counter', 'integration.json'),
      'utf8'
    )
  );
  const validation = validateIntegrationDefinition(definition);
  assert.equal(validation.success, true, JSON.stringify(validation.errors));
  assert.equal(validation.data.id, TEST_TOOLS_DEFINITION);
  assert.deepEqual(validation.data.protocol, { type: 'native', module: TEST_TOOLS_CONNECTOR_ID });
  assert.deepEqual(
    validation.data.actions.map(action => [action.name, action.toolId, action.sideEffect]),
    [
      [COUNTER_WRITE, COUNTER_WRITE, 'write'],
      [COUNTER_READ, COUNTER_READ, 'read']
    ]
  );
  // The actions the definition names are the ones the connector implements.
  assert.deepEqual(
    validation.data.actions.map(action => action.name),
    [...TEST_TOOL_IDS]
  );

  const integrations = JSON.parse(fs.readFileSync(integrationsPath, 'utf8'));
  assert.deepEqual(
    integrations.installed.map(installed => installed.id),
    ['ihub', TEST_TOOLS_INSTALLATION]
  );
  assert.deepEqual(integrations.security, { blockPrivateIps: true });
});

test('iHub ships no definition of the test tools', () => {
  const shipped = path.join(serverDir, 'defaults', 'integration-definitions');
  for (const dir of fs.readdirSync(shipped)) {
    const file = path.join(shipped, dir, 'integration.json');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(TEST_TOOLS_CONNECTOR_ID), `${dir} names the test connector`);
    assert.ok(!text.includes('e2e_counter'), `${dir} names a test tool`);
  }
});

// --- real processes: what a server registers at start ----------------------------

/** Import the connector registration in a process of its own and print what it registered. */
function registeredIn(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('IHUB_TEST_') || key === 'NODE_TEST_CONTEXT') delete clean[key];
  }
  const script = `
    await import(${JSON.stringify(pathToFileURL(path.join(connectorsDir, 'register.js')).href)});
    const { getConnector, connectorIds } = await import(${JSON.stringify(
      pathToFileURL(path.join(connectorsDir, 'index.js')).href
    )});
    console.log('RESULT ' + JSON.stringify({
      testTools: Boolean(getConnector(${JSON.stringify(TEST_TOOLS_CONNECTOR_ID)})),
      count: connectorIds().length
    }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: serverDir,
    env: { ...clean, LOG_LEVEL: 'warn', ...env },
    encoding: 'utf8'
  });
  const line = result.stdout.split('\n').find(text => text.startsWith('RESULT '));
  assert.ok(line, `no result (exit ${result.status}): ${result.stderr.slice(-2000)}`);
  return { ...JSON.parse(line.slice('RESULT '.length)), output: result.stdout + result.stderr };
}

test('a server with NODE_ENV=production does not register the tools, even with IHUB_TEST_TOOLS=1', () => {
  const production = registeredIn({ NODE_ENV: 'production', IHUB_TEST_TOOLS: '1' });
  assert.equal(production.testTools, false);
  assert.ok(!production.output.includes('TEST ONLY'), 'and prints no warning');

  const testWithoutSwitch = registeredIn({ NODE_ENV: 'test' });
  assert.equal(testWithoutSwitch.testTools, false);
  assert.equal(testWithoutSwitch.count, production.count);
});

test('a server with NODE_ENV=test and IHUB_TEST_TOOLS=1 registers them and says so once', () => {
  const armed = registeredIn({ NODE_ENV: 'test', IHUB_TEST_TOOLS: '1' });
  assert.equal(armed.testTools, true);
  assert.equal(armed.output.split('TEST ONLY: the test tools').length - 1, 1, armed.output);
});
