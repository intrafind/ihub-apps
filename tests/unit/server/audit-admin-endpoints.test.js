import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * scripts/audit-admin-endpoints.js (npm run security:audit, run in CI) must
 * flag every admin route without adminAuth/contentAdminAuth. These cases run
 * it against small route files to pin down how it reads the middleware list.
 */

const script = path.resolve(__dirname, '../../../scripts/audit-admin-endpoints.js');

/**
 * Runs the audit on one route file with |source|. The script reads
 * ../server/routes/admin next to itself, so a copy runs in a temporary tree.
 */
function audit(source) {
  const root = mkdtempSync(path.join(tmpdir(), 'admin-audit-'));
  try {
    const routesDir = path.join(root, 'server/routes/admin');
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(routesDir, { recursive: true });
    copyFileSync(script, path.join(root, 'scripts/audit.mjs'));
    writeFileSync(path.join(routesDir, 'routes.js'), source);
    const output = execFileSync('node', [path.join(root, 'scripts/audit.mjs')], {
      encoding: 'utf8'
    });
    return { status: 0, output };
  } catch (error) {
    return { status: error.status, output: error.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('admin route audit', () => {
  test('passes when every route is guarded', () => {
    const { status } = audit(`
      app.get(buildServerPath('/api/admin/a'), adminAuth, listThings);
      app.post(buildServerPath('/api/admin/b'), contentAdminAuth, async (req, res) => {});
    `);
    expect(status).toBe(0);
  });

  test('flags a route with an inline handler and no guard', () => {
    const { status, output } = audit(`
      app.get(buildServerPath('/api/admin/a'), authRequired, async (req, res) => {
        // adminAuth is mentioned here, in the handler, which does not count
      });
    `);
    expect(status).toBe(1);
    expect(output).toContain('[VULNERABILITY] GET /api/admin/a');
  });

  test('does not credit a named-handler route with the next route’s guard', () => {
    const { status, output } = audit(`
      app.get(buildServerPath('/api/admin/unguarded'), listThings);
      app.post(buildServerPath('/api/admin/guarded'), adminAuth, async (req, res) => {});
    `);
    expect(status).toBe(1);
    expect(output).toContain('[VULNERABILITY] GET /api/admin/unguarded');
    expect(output).not.toContain('POST /api/admin/guarded');
  });

  test('ignores parentheses and quotes in comments inside a route call', () => {
    for (const comment of ['// TODO (auth', "// don't cache", '/* see (below */']) {
      const { status, output } = audit(`
        app.get(
          buildServerPath('/api/admin/unguarded'),
          ${comment}
          listThings
        );
        app.post(buildServerPath('/api/admin/guarded'), adminAuth, async (req, res) => {});
      `);
      expect({ comment, status }).toEqual({ comment, status: 1 });
      expect(output).toContain('[VULNERABILITY] GET /api/admin/unguarded');
    }
  });

  test('counts a guard only when it is passed as an argument of its own', () => {
    for (const route of [
      "app.get(buildServerPath('/api/admin/a'), validate({ pattern: /adminAuth/ }), listThings);",
      "app.get(buildServerPath('/api/admin/a'), wrap(adminAuth.optional), listThings);",
      "app.get(buildServerPath('/api/admin/a'), log('adminAuth skipped'), listThings);",
      "app.get(buildServerPath('/api/admin/a'), /* adminAuth */ listThings);",
      `app.get(
        buildServerPath('/api/admin/a'),
        // adminAuth,
        listThings
      );`
    ]) {
      const { status, output } = audit(route);
      expect({ route, status }).toEqual({ route, status: 1 });
      expect(output).toContain('[VULNERABILITY] GET /api/admin/a');
    }
  });

  test('reads a guard passed through a call in the middleware list', () => {
    const { status } = audit(`
      app.put(buildServerPath('/api/admin/a'), rateLimit({ window: '1m (x)' }), adminAuth, saveThing);
    `);
    expect(status).toBe(0);
  });
});
