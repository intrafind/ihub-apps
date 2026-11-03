// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * V213: an installation of a hosted MCP definition that moved to the
 * marketplace keeps its definition (written under contents, recorded as
 * installed from ihub-official); unused definitions are not written; an
 * existing folder is left alone; a second run changes nothing. A generic MCP
 * installation (V193 on an upgrade from 5.6.x, or added by hand) is re-linked
 * to the moved definition when its connection stays exactly the same.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  up,
  precondition,
  version,
  description,
  MOVED_DEFINITIONS,
  relinkFor
} from '../migrations/V213__mcp_definitions_to_marketplace.js';
import { instanceFrom } from '../migrations/V193__mcp_servers_installed_integrations.js';
import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';

let contentsDir;
let logs;

function ctxFor() {
  const full = rel => path.join(contentsDir, rel);
  return {
    contentsDir,
    readJson: async rel => JSON.parse(await fs.readFile(full(rel), 'utf8')),
    writeJson: async (rel, data) => {
      await fs.mkdir(path.dirname(full(rel)), { recursive: true });
      await fs.writeFile(full(rel), JSON.stringify(data, null, 2));
    },
    fileExists: async rel =>
      fs
        .access(full(rel))
        .then(() => true)
        .catch(() => false),
    log: m => logs.push(m),
    warn: m => logs.push(`WARN ${m}`)
  };
}

async function seed(rel, data) {
  await fs.mkdir(path.dirname(path.join(contentsDir, rel)), { recursive: true });
  await fs.writeFile(path.join(contentsDir, rel), JSON.stringify(data));
}

const OFFICIAL = { registries: [{ id: 'ihub-official', enabled: true }] };

describe('V213 hosted MCP definitions → marketplace', () => {
  beforeEach(async () => {
    contentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v213-'));
    logs = [];
  });
  afterEach(async () => {
    await fs.rm(contentsDir, { recursive: true, force: true });
  });

  it('declares its version', () => {
    assert.equal(version, '213');
    assert.equal(description, 'mcp_definitions_to_marketplace');
  });

  it('snapshots 29 valid definitions, none of them builtIn', () => {
    assert.equal(Object.keys(MOVED_DEFINITIONS).length, 29);
    for (const [folder, def] of Object.entries(MOVED_DEFINITIONS)) {
      assert.equal(def.id.replace('/', '__'), folder);
      assert.notEqual(def.builtIn, true, folder);
      assert.equal(def.releases[0].version, def.version, folder);
      const parsed = validateIntegrationDefinition(def);
      assert.ok(parsed.success, `${folder}: ${JSON.stringify(parsed.errors)}`);
    }
  });

  it('skips without an integrations file', async () => {
    assert.equal(await precondition(ctxFor()), false);
  });

  it('writes the used definitions and records them as installed from ihub-official', async () => {
    await seed('config/integrations.json', {
      installed: [
        { id: 'gh', definition: 'mcp/github' },
        { id: 'gh-2', definition: 'mcp/github' },
        { id: 'docs', definition: 'mcp/context7' }
      ]
    });
    await seed('config/registries.json', OFFICIAL);
    await seed('config/installations.json', { installations: {} });
    const ctx = ctxFor();
    assert.equal(await precondition(ctx), true);
    await up(ctx);

    const written = await ctx.readJson('integration-definitions/mcp__github/integration.json');
    assert.deepEqual(written, MOVED_DEFINITIONS.mcp__github);
    assert.equal(await ctx.fileExists('integration-definitions/mcp__linear'), false);
    assert.equal(await ctx.fileExists('integration-definitions/mcp__context7'), false);
    const manifest = await ctx.readJson('config/installations.json');
    assert.deepEqual(Object.keys(manifest.installations), ['integration:mcp__github']);
    assert.equal(manifest.installations['integration:mcp__github'].registryId, 'ihub-official');
    assert.equal(manifest.installations['integration:mcp__github'].version, '1.0.0');

    // A second run changes nothing.
    const before = await fs.readFile(path.join(contentsDir, 'config/installations.json'), 'utf8');
    await up(ctx);
    const after = await fs.readFile(path.join(contentsDir, 'config/installations.json'), 'utf8');
    assert.equal(after, before);
  });

  it('leaves an existing folder alone', async () => {
    await seed('config/integrations.json', { installed: [{ id: 's', definition: 'mcp/stripe' }] });
    await seed('config/registries.json', OFFICIAL);
    await seed('integration-definitions/mcp__stripe/integration.json', { id: 'mcp/stripe', x: 1 });
    await up(ctxFor());
    const kept = await ctxFor().readJson('integration-definitions/mcp__stripe/integration.json');
    assert.equal(kept.x, 1);
    assert.equal(await ctxFor().fileExists('config/installations.json'), false);
  });

  it('writes a local definition without a record when ihub-official is not configured', async () => {
    await seed('config/integrations.json', { installed: [{ id: 'l', definition: 'mcp/linear' }] });
    await up(ctxFor());
    assert.equal(
      await ctxFor().fileExists('integration-definitions/mcp__linear/integration.json'),
      true
    );
    assert.equal(await ctxFor().fileExists('config/installations.json'), false);
    assert.ok(logs.some(m => m.startsWith('WARN mcp/linear')));
  });

  describe('re-linking generic installations', () => {
    // What V193 makes of a 5.6.x server now that the moved definitions no
    // longer ship: an installation of the generic definition.
    const fromV193 = server => instanceFrom(server, []);

    it('re-links a bearer server V193 converted, keeping id, credential and policy', () => {
      const generic = fromV193({
        id: 'github',
        name: 'GitHub',
        transport: { type: 'streamableHttp', url: 'https://api.githubcopilot.com/mcp/' },
        auth: { type: 'bearer', tokenRef: 'github-token' },
        allowedTools: ['get_issue'],
        timeoutMs: 60000
      });
      assert.equal(generic.definition, 'com.intrafind/mcp-server');
      const result = relinkFor(generic);
      assert.equal(result.folder, 'mcp__github');
      const inst = result.instance;
      assert.equal(inst.id, 'github');
      assert.equal(inst.definition, 'mcp/github');
      assert.equal(inst.definitionVersion, '1.0.0');
      assert.deepEqual(inst.values, {});
      assert.deepEqual(inst.auth, { mode: 'service-account', credentialRef: 'github-token' });
      assert.deepEqual(inst.actions.enabled, ['get_issue']);
      assert.equal(inst.timeoutMs, 60000);
      assert.deepEqual(inst.label, { en: 'GitHub' });
    });

    it('re-links a header-key server with the same header, and a keyless one', () => {
      const maps = relinkFor(
        fromV193({
          id: 'maps',
          transport: { type: 'streamableHttp', url: 'https://mapstools.googleapis.com/mcp' },
          auth: { type: 'header', headerName: 'x-goog-api-key', valueRef: 'k' }
        })
      );
      assert.equal(maps.instance.definition, 'mcp/google-maps');
      const learn = relinkFor(
        fromV193({
          id: 'learn',
          transport: { type: 'streamableHttp', url: 'https://learn.microsoft.com/api/mcp/' }
        })
      );
      assert.equal(learn.instance.definition, 'mcp/microsoft-learn');
      assert.deepEqual(learn.instance.auth, { mode: 'none' });
    });

    it('keeps Close generic without its scope header, re-links it with one', () => {
      const close = extra => ({
        id: 'close',
        transport: { type: 'streamableHttp', url: 'https://mcp.close.com/mcp', ...extra },
        auth: { type: 'header', headerName: 'Close-API-Key', valueRef: 'c' }
      });
      assert.match(relinkFor(fromV193(close())).reason, /Close-Scope/i);
      const ok = relinkFor(fromV193(close({ headers: { 'Close-Scope': 'mcp.write_safe' } })));
      assert.equal(ok.instance.definition, 'mcp/close');
      assert.deepEqual(ok.instance.values, { headers: ['Close-Scope: mcp.write_safe'] });
    });

    it('keeps a server generic when the connection would change', () => {
      const github = extra => ({
        id: 'gh',
        transport: { type: 'streamableHttp', url: 'https://api.githubcopilot.com/mcp/' },
        auth: { type: 'bearer', tokenRef: 't' },
        ...extra
      });
      const cases = [
        github({ auth: { type: 'oauthUser', clientId: 'c' } }),
        github({ auth: { type: 'header', headerName: 'X-Key', valueRef: 't' } }),
        github({ toolPrefix: 'git_' }),
        github({ apps: { enabled: false } }),
        github({ reconnect: { maxRetries: 9 } }),
        github({ timeoutMs: 300000 })
      ];
      for (const server of cases) {
        const result = relinkFor(fromV193(server));
        assert.ok(result?.reason, JSON.stringify(server));
      }
      assert.equal(
        relinkFor(
          fromV193({
            id: 'x',
            transport: { type: 'streamableHttp', url: 'https://mcp.example.com' }
          })
        ),
        null
      );
    });

    it('writes the re-linked installation and installs its definition', async () => {
      const generic = fromV193({
        id: 'linear',
        transport: { type: 'streamableHttp', url: 'https://mcp.linear.app/mcp' },
        auth: { type: 'bearer', tokenRef: 'lin' }
      });
      const kept = fromV193({
        id: 'other',
        transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' }
      });
      await seed('config/integrations.json', { security: { x: 1 }, installed: [generic, kept] });
      await seed('config/registries.json', OFFICIAL);
      const ctx = ctxFor();
      await up(ctx);
      const config = await ctx.readJson('config/integrations.json');
      assert.deepEqual(config.security, { x: 1 });
      assert.equal(config.installed[0].definition, 'mcp/linear');
      assert.deepEqual(config.installed[1], kept);
      assert.equal(
        await ctx.fileExists('integration-definitions/mcp__linear/integration.json'),
        true
      );
      const manifest = await ctx.readJson('config/installations.json');
      assert.ok(manifest.installations['integration:mcp__linear']);
      assert.ok(logs.some(m => m.includes('linear: re-linked')));
    });

    const stripe = () =>
      fromV193({
        id: 'stripe',
        transport: { type: 'streamableHttp', url: 'https://mcp.stripe.com' },
        auth: { type: 'bearer', tokenRef: 's' }
      });

    it('does not re-link to an unusable folder on disk', async () => {
      await seed('config/integrations.json', { installed: [stripe()] });
      await seed('integration-definitions/mcp__stripe/integration.json', {
        id: 'mcp/stripe',
        version: '2.0.0'
      });
      await up(ctxFor());
      const config = await ctxFor().readJson('config/integrations.json');
      assert.equal(config.installed[0].definition, 'com.intrafind/mcp-server');
    });

    it('checks the connection of a hand-written folder of the same version, not its version', async () => {
      const elsewhere = structuredClone(MOVED_DEFINITIONS.mcp__stripe);
      elsewhere.protocol.transport.url = 'https://collector.example.com/mcp';
      await seed('config/integrations.json', { installed: [stripe()] });
      await seed('integration-definitions/mcp__stripe/integration.json', elsewhere);
      await up(ctxFor());
      const config = await ctxFor().readJson('config/integrations.json');
      assert.equal(config.installed[0].definition, 'com.intrafind/mcp-server');
      assert.ok(logs.some(m => m.includes('stays an installation') && m.includes('collector')));
    });

    it('re-links to a folder on disk whose connection matches, at its version', async () => {
      const newer = structuredClone(MOVED_DEFINITIONS.mcp__stripe);
      newer.version = '1.1.0';
      await seed('config/integrations.json', { installed: [stripe()] });
      await seed('integration-definitions/mcp__stripe/integration.json', newer);
      await up(ctxFor());
      const config = await ctxFor().readJson('config/integrations.json');
      assert.equal(config.installed[0].definition, 'mcp/stripe');
      assert.equal(config.installed[0].definitionVersion, '1.1.0');
    });

    it('writes a kept header in the definition spelling', () => {
      const result = relinkFor(
        fromV193({
          id: 'close',
          transport: {
            type: 'streamableHttp',
            url: 'https://mcp.close.com/mcp',
            headers: { 'close-scope': 'mcp.write_safe', 'X-Trace': '1' }
          },
          auth: { type: 'header', headerName: 'close-api-key', valueRef: 'c' }
        })
      );
      assert.deepEqual(result.instance.values, {
        headers: ['Close-Scope: mcp.write_safe', 'X-Trace: 1']
      });
    });
  });
});

describe('V213 re-linking keeps the connection', () => {
  it('builds the same MCP server config before and after, for every moved definition', async () => {
    const { rawServerConfigFor } =
      await import('../services/integrations/protocols/mcp/serverConfig.js');
    const { effectiveValues } =
      await import('../services/integrations/definitions/installedValues.js');
    const generic = JSON.parse(
      await fs.readFile(
        new URL(
          '../defaults/integration-definitions/com.intrafind__mcp-server/integration.json',
          import.meta.url
        ),
        'utf8'
      )
    );
    const connection = (definition, instance) => {
      const config = rawServerConfigFor({
        definition,
        instance,
        values: effectiveValues(definition, instance)
      });
      delete config.name;
      delete config.description;
      // HTTP header names are case-insensitive, but two spellings of one
      // name would both be sent: fail on that, then compare in lower case.
      const headers = config.transport.headers || {};
      const lower = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
      );
      assert.equal(Object.keys(lower).length, Object.keys(headers).length, 'duplicate header');
      if (config.transport.headers) config.transport.headers = lower;
      if (config.auth?.headerName) config.auth.headerName = config.auth.headerName.toLowerCase();
      return config;
    };
    for (const [folder, def] of Object.entries(MOVED_DEFINITIONS)) {
      const account = def.auth.serviceAccount;
      const auth = !def.auth.modes.includes('service-account')
        ? { type: 'none' }
        : account.kind === 'header'
          ? {
              type: 'header',
              headerName: account.header,
              valuePrefix: account.valuePrefix,
              valueRef: 'ref'
            }
          : { type: 'bearer', tokenRef: 'ref' };
      // As the definition spells the headers, and as an admin may have
      // typed them by hand (lower case).
      for (const lowerCase of [false, true]) {
        const spell = name => (lowerCase ? name.toLowerCase() : name);
        const headers = Object.fromEntries(
          Object.entries(def.protocol.transport.headers || {}).map(([n, v]) => [spell(n), v])
        );
        const server = {
          id: 'srv',
          transport: {
            ...def.protocol.transport,
            headers: Object.keys(headers).length ? headers : undefined
          },
          auth: auth.headerName ? { ...auth, headerName: spell(auth.headerName) } : auth,
          timeoutMs: 45000
        };
        const before = instanceFrom(server, []);
        const result = relinkFor(before);
        assert.ok(result?.instance, `${folder}: ${result?.reason}`);
        assert.deepEqual(
          connection(def, result.instance),
          connection(generic, before),
          `${folder}${lowerCase ? ' (lower case)' : ''}`
        );
      }
    }
  });
});
