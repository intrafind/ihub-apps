/**
 * PostgresProvider Test Suite
 *
 * Exercises the provider against an in-memory fake pool (no real Postgres
 * connection needed) so it also runs in environments without a DB available.
 */

import { PostgresProvider } from '../persistence/PostgresProvider.js';

function createFakePool() {
  const table = new Map(); // path -> data
  return {
    calls: [],
    async query(rawSql, params = []) {
      const sql = rawSql.trim();
      this.calls.push({ sql, params });
      if (sql.startsWith('CREATE TABLE')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT data FROM config_kv WHERE path')) {
        const [key] = params;
        return table.has(key) ? { rows: [{ data: table.get(key) }] } : { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM config_kv WHERE path')) {
        const [key] = params;
        return table.has(key) ? { rows: [{}] } : { rows: [] };
      }
      if (sql.startsWith('INSERT INTO config_kv')) {
        const [key, data] = params;
        table.set(key, data);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM config_kv WHERE path')) {
        const [key] = params;
        table.delete(key);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT path FROM config_kv WHERE path LIKE')) {
        const [likePattern] = params;
        const prefix = likePattern.slice(0, -1); // strip trailing '%'
        const rows = [...table.keys()]
          .filter(key => key.startsWith(prefix))
          .map(key => ({ path: key }));
        return { rows };
      }
      throw new Error(`Unhandled query in fake pool: ${sql}`);
    }
  };
}

describe('PostgresProvider', () => {
  let pool;
  let provider;

  beforeEach(() => {
    pool = createFakePool();
    provider = new PostgresProvider(pool);
  });

  it('returns null for a path that was never written', async () => {
    expect(await provider.read('config/platform.json')).toBeNull();
  });

  it('writes then reads back the same content', async () => {
    await provider.write('config/platform.json', '{"a":1}');
    expect(await provider.read('config/platform.json')).toBe('{"a":1}');
  });

  it('write() upserts on repeated calls for the same path', async () => {
    await provider.write('a.json', '{"v":1}');
    await provider.write('a.json', '{"v":2}');
    expect(await provider.read('a.json')).toBe('{"v":2}');
  });

  it('exists() reflects presence', async () => {
    expect(await provider.exists('a.json')).toBe(false);
    await provider.write('a.json', '{}');
    expect(await provider.exists('a.json')).toBe(true);
  });

  it('delete() removes the row', async () => {
    await provider.write('a.json', '{}');
    await provider.delete('a.json');
    expect(await provider.exists('a.json')).toBe(false);
  });

  it('list() returns sorted entry names scoped to the directory prefix', async () => {
    await provider.write('apps/b.json', '{}');
    await provider.write('apps/a.json', '{}');
    await provider.write('apps/nested/c.json', '{}'); // not a direct child, must be excluded
    expect(await provider.list('apps')).toEqual(['a.json', 'b.json']);
  });

  it('list() applies the optional pattern filter', async () => {
    await provider.write('apps/a.json', '{}');
    await provider.write('apps/a.json.bak', '{}');
    expect(await provider.list('apps', { pattern: /\.json$/ })).toEqual(['a.json']);
  });

  it('normalizes backslashes and leading slashes in paths', async () => {
    await provider.write('\\config\\platform.json', '{}');
    expect(await provider.read('config/platform.json')).toBe('{}');
  });

  it('ensures the schema exactly once across multiple calls', async () => {
    await provider.read('a.json');
    await provider.write('b.json', '{}');
    await provider.exists('c.json');
    const createCalls = pool.calls.filter(c => c.sql.startsWith('CREATE TABLE'));
    expect(createCalls).toHaveLength(1);
  });
});
