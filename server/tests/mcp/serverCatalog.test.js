import { describe, it, expect } from '@jest/globals';
import { MCP_SERVER_CATALOG, MCP_CATALOG_CATEGORIES } from '../../services/mcp/serverCatalog.js';
import { mcpServerConfigSchema } from '../../validators/mcpServerConfigSchema.js';

// What the admin form sends once a credential has been picked for the entry.
function toServerConfig(entry) {
  const auth = {
    none: () => entry.auth,
    bearer: () => ({ type: 'bearer', tokenRef: 'cred' }),
    basic: () => ({ type: 'basic', username: 'admin@example.com', passwordRef: 'cred' }),
    header: () => ({ ...entry.auth, valueRef: 'cred' })
  }[entry.auth.type]();
  return {
    id: entry.id,
    name: { en: entry.name },
    description: { en: entry.description.en },
    transport: entry.transport,
    auth
  };
}

describe('MCP server catalog', () => {
  it('has unique ids', () => {
    const ids = MCP_SERVER_CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(MCP_SERVER_CATALOG.map(e => [e.id, e]))(
    '%s becomes a valid server config',
    (_id, entry) => {
      const result = mcpServerConfigSchema.safeParse(toServerConfig(entry));
      expect(result.error?.issues).toBeUndefined();
    }
  );

  it.each(MCP_SERVER_CATALOG.map(e => [e.id, e]))('%s is complete', (_id, entry) => {
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.vendor).toBe('string');
    expect(MCP_CATALOG_CATEGORIES).toContain(entry.category);
    expect(entry.description.en).toBeTruthy();
    expect(entry.description.de).toBeTruthy();
    expect(entry.docsUrl).toMatch(/^https:\/\//);
    expect(entry.transport.url).toMatch(/^https:\/\//);
    if (entry.auth.type !== 'none') {
      expect(entry.credentialHint?.en).toBeTruthy();
      expect(entry.credentialHint?.de).toBeTruthy();
    }
    if (entry.notes) {
      expect(entry.notes.en).toBeTruthy();
      expect(entry.notes.de).toBeTruthy();
    }
  });

  it('lists only servers that work with a shared, static credential', () => {
    for (const entry of MCP_SERVER_CATALOG) {
      expect(['none', 'bearer', 'basic', 'header']).toContain(entry.auth.type);
      expect(Object.keys(entry.auth).some(k => k.endsWith('Ref'))).toBe(false);
    }
  });

  it('uses every category it declares', () => {
    const used = new Set(MCP_SERVER_CATALOG.map(e => e.category));
    expect(MCP_CATALOG_CATEGORIES.filter(c => !used.has(c))).toEqual([]);
  });
});
