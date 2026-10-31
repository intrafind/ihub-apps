// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { IntegrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');

const doc = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: { '/x': { get: { operationId: 'x', responses: {} } } }
});

function definition(id, extra = {}) {
  return {
    id,
    version: '1.0.0',
    name: { en: id },
    protocol: { type: 'openapi', document: 'api.json', baseUrl: '{baseUrl}' },
    auth: { modes: ['none'] },
    install: [{ key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true }],
    actions: [{ name: 'x', operationId: 'x', sideEffect: 'read' }],
    ...extra
  };
}

let root;
let shippedDir;
let contentsDir;

async function writeDefinition(base, dirName, def, files = { 'api.json': doc }) {
  const dir = path.join(base, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(def), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-integration-registry-'));
  shippedDir = path.join(root, 'shipped');
  contentsDir = path.join(root, 'contents');
  await fs.mkdir(shippedDir);
  await fs.mkdir(contentsDir);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('IntegrationRegistry', () => {
  it('loads shipped and installed definitions, the installed one winning', async () => {
    await writeDefinition(shippedDir, 'org.a__one', definition('org.a/one', { version: '1.0.0' }));
    await writeDefinition(shippedDir, 'org.b', definition('org.b'));
    await writeDefinition(contentsDir, 'org.a__one', definition('org.a/one', { version: '2.0.0' }));
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    expect(
      registry
        .list()
        .map(e => e.id)
        .sort()
    ).toEqual(['org.a/one', 'org.b']);
    const one = registry.get('org.a/one');
    expect(one.source).toBe('installed');
    expect(one.definition.version).toBe('2.0.0');
    expect(one.document.paths['/x']).toBeDefined();
    expect(registry.isInstalled('org.a/one')).toBe(true);
    expect(registry.isInstalled('org.b')).toBe(false);
  });

  it('skips invalid definitions, unreadable documents and files that are not JSON', async () => {
    await writeDefinition(shippedDir, 'ok', definition('ok'));
    await writeDefinition(shippedDir, 'bad.schema', { id: 'bad.schema', version: 'x' });
    await writeDefinition(shippedDir, 'no.doc', definition('no.doc'), {});
    await writeDefinition(shippedDir, 'bad.doc', definition('bad.doc'), {
      'api.json': '{"notOpenApi":1}'
    });
    await fs.mkdir(path.join(shippedDir, 'garbage'));
    await fs.writeFile(path.join(shippedDir, 'garbage', 'integration.json'), '{not json', 'utf8');
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    expect(registry.list().map(e => e.id)).toEqual(['ok']);
  });

  it('writes an installed definition folder with companions and removes it again', async () => {
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    const entry = await registry.writeInstalled('org.new/thing', {
      'integration.json': definition('org.new/thing'),
      'api.json': doc,
      'README.md': '# hi'
    });
    expect(entry.source).toBe('installed');
    expect(entry.document.paths['/x']).toBeDefined();
    const readme = await fs.readFile(path.join(contentsDir, 'org.new__thing', 'README.md'), 'utf8');
    expect(readme).toBe('# hi');
    await registry.removeInstalled('org.new/thing');
    expect(registry.get('org.new/thing')).toBeNull();
    await expect(fs.stat(path.join(contentsDir, 'org.new__thing'))).rejects.toThrow();
  });

  it('keeps the previous folder when a re-install fails before or during the swap', async () => {
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    const files = version => ({
      'integration.json': definition('org.new/thing', { version }),
      'api.json': doc,
      'README.md': `# ${version}`
    });
    await registry.writeInstalled('org.new/thing', files('1.0.0'));
    const dir = path.join(contentsDir, 'org.new__thing');

    // The new document does not parse: nothing is touched.
    await expect(
      registry.writeInstalled('org.new/thing', { ...files('2.0.0'), 'api.json': 'not json {' })
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# 1.0.0');

    // The swap itself fails after the old folder was moved aside: it comes back.
    registry._swapIn = async () => {
      throw new Error('disk full');
    };
    await expect(registry.writeInstalled('org.new/thing', files('2.0.0'))).rejects.toThrow(
      'disk full'
    );
    expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('# 1.0.0');
    await registry.reload();
    expect(registry.get('org.new/thing').definition.version).toBe('1.0.0');
    const leftovers = (await fs.readdir(contentsDir)).filter(name => name.startsWith('.'));
    expect(leftovers).toEqual([]);
  });

  it('refuses a mismatching id, a stdio protocol and path traversal in companions', async () => {
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    await expect(
      registry.writeInstalled('org.x/y', {
        'integration.json': definition('org.other/y'),
        'api.json': doc
      })
    ).rejects.toThrow(/does not match/);
    await expect(
      registry.writeInstalled('local.stdio', {
        'integration.json': definition('local.stdio', {
          protocol: { type: 'mcp', transport: { type: 'stdio', command: 'npx' } },
          actions: []
        })
      })
    ).rejects.toThrow(/stdio/);
    await expect(
      registry.writeInstalled('org.x/y', {
        'integration.json': definition('org.x/y'),
        'api.json': doc,
        '../escape.txt': 'x'
      })
    ).rejects.toThrow(/traversal/);
    expect(registry.get('org.x/y')).toBeNull();
  });

  it('loads a definition the server version does not satisfy as incompatible, without tools', async () => {
    await writeDefinition(
      shippedDir,
      'org.old',
      definition('org.old', { compatibility: { ihub: '<1.0.0' } })
    );
    await writeDefinition(
      shippedDir,
      'org.fine',
      definition('org.fine', { compatibility: { ihub: '>=1.0.0' } })
    );
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    const old = registry.get('org.old');
    expect(old.status).toBe('incompatible');
    expect(old.compatibility).toMatchObject({ requires: '<1.0.0', compatible: false });
    expect(old.statusReason).toMatch(/needs iHub <1\.0\.0, this server runs/);
    expect(registry.isIncompatible('org.old')).toBe(true);
    expect(registry.get('org.fine').status).toBe('ok');
    expect(registry.isIncompatible('org.fine')).toBe(false);
    // Still in the catalog: its installations are listed with the reason.
    expect(
      registry
        .list()
        .map(e => e.id)
        .sort()
    ).toEqual(['org.fine', 'org.old']);
  });

  it('refuses a definition written for an unknown schema revision before reading anything else', async () => {
    await writeDefinition(shippedDir, 'org.future', {
      ...definition('org.future'),
      compatibility: { schema: 2 },
      futureField: { only: 'a later server knows this' }
    });
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    expect(registry.get('org.future')).toBeNull();
    await expect(
      registry.writeInstalled('org.future', {
        'integration.json': { ...definition('org.future'), compatibility: { schema: 2 } },
        'api.json': doc
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DEFINITION_SCHEMA' });
    expect(registry.get('org.future')).toBeNull();
  });

  it('serves release notes from the folder and drops a note whose file is missing', async () => {
    const releases = [
      {
        version: '1.0.0',
        date: '2026-10-31',
        summary: { en: 'First version.' },
        notes: {
          features: 'releases/1.0.0/features.md',
          breaking: 'releases/1.0.0/breaking-changes.md'
        }
      }
    ];
    await writeDefinition(shippedDir, 'org.notes', definition('org.notes', { releases }), {
      'api.json': doc
    });
    await fs.mkdir(path.join(shippedDir, 'org.notes', 'releases', '1.0.0'), { recursive: true });
    await fs.writeFile(
      path.join(shippedDir, 'org.notes', 'releases', '1.0.0', 'features.md'),
      '# Features\n',
      'utf8'
    );
    await fs.writeFile(path.join(shippedDir, 'org.notes', 'secret.md'), 'hidden', 'utf8');
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    const entry = registry.get('org.notes');
    expect(entry.definition.releases[0].notes).toEqual({ features: 'releases/1.0.0/features.md' });
    expect(await registry.readCompanion('org.notes', 'releases/1.0.0/features.md')).toBe(
      '# Features\n'
    );
    // Any Markdown companion of the folder can be read, nothing else, and
    // nothing outside the folder.
    expect(await registry.readCompanion('org.notes', 'secret.md')).toBe('hidden');
    expect(await registry.readCompanion('org.notes', 'api.json')).toBeNull();
    expect(await registry.readCompanion('org.notes', '../org.notes/secret.md')).toBeNull();
    expect(await registry.readCompanion('org.notes', 'releases/../../x.md')).toBeNull();
    expect(await registry.readCompanion('org.notes', '/etc/passwd.md')).toBeNull();
    expect(await registry.readCompanion('org.notes', 'releases/1.0.0/missing.md')).toBeNull();
    expect(await registry.readCompanion('org.unknown', 'secret.md')).toBeNull();
  });

  it('writes an installed definition with its releases subfolder', async () => {
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    const entry = await registry.writeInstalled('org.new/thing', {
      'integration.json': definition('org.new/thing', {
        releases: [
          {
            version: '1.0.0',
            date: '2026-10-31',
            summary: { en: 'First' },
            notes: { features: 'releases/1.0.0/features.md' }
          }
        ]
      }),
      'api.json': doc,
      'releases/1.0.0/features.md': '# First\n'
    });
    expect(entry.definition.releases[0].notes.features).toBe('releases/1.0.0/features.md');
    expect(await registry.readCompanion('org.new/thing', 'releases/1.0.0/features.md')).toBe(
      '# First\n'
    );
  });

  it('tolerates a missing contents directory', async () => {
    await fs.rm(contentsDir, { recursive: true, force: true });
    await writeDefinition(shippedDir, 'ok', definition('ok'));
    const registry = new IntegrationRegistry({ shippedDir, contentsDir });
    await registry.reload();
    expect(registry.list()).toHaveLength(1);
  });
});
