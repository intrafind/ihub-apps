import { readFileSync } from 'fs';
import path from 'path';

/**
 * Base-path detection exists twice: `KNOWN_ROUTES` in runtimeBasePath.js for the
 * React app, and an inline copy in client/index.html that runs before any bundle
 * so the pre-React auth gate knows where `/api` lives. A route missing from the
 * inline copy is read as a deployment subpath, and the gate then requests
 * `/<route>/api/auth/status` and fails with "Unable to connect to the server".
 * That only shows on a cold load of the missing route, which is easy to miss by
 * hand — so pin the two lists together here.
 *
 * Both are read as source text: runtimeBasePath.js uses `import.meta`, which the
 * Jest transform cannot parse, and textual sync is exactly what is at stake.
 */

const repoRoot = path.resolve(__dirname, '../../..');

function routesFrom(relPath, pattern) {
  const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const match = source.match(pattern);
  if (!match) throw new Error(`route list not found in ${relPath}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

const moduleRoutes = () =>
  routesFrom('client/src/utils/runtimeBasePath.js', /export const KNOWN_ROUTES = \[([\s\S]*?)\];/);
const inlineRoutes = () => routesFrom('client/index.html', /const knownRoutes = \[([\s\S]*?)\];/);

describe('known route lists', () => {
  test('the inline copy in client/index.html matches KNOWN_ROUTES exactly', () => {
    expect(inlineRoutes()).toEqual(moduleRoutes());
  });

  test('the top-level pages users land on are listed', () => {
    // The routes "/" can redirect to, plus the ones the sidebar links to.
    const routes = moduleRoutes();
    for (const route of ['start', 'apps', 'pages', 'prompts', 'admin']) {
      expect(routes).toContain(route);
    }
  });

  test('the pages that decide their own audience are listed', () => {
    // Public share links and a public detector open with nobody signed in.
    const routes = moduleRoutes();
    expect(routes).toContain('share');
    expect(routes).toContain('verify');
  });
});

describe('pages exempt from the sign-in redirects', () => {
  // `isSelfGatedPath` exists twice as well: in runtimeBasePath.js for the
  // React auth context, and in the pre-React auth gate. Both must let the same
  // pages through, or a public link works on one load path and not the other.
  const exemptionIn = relPath => {
    const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
    const start =
      source.indexOf('isSelfGatedPath = (') >= 0
        ? source.indexOf('isSelfGatedPath = (')
        : source.indexOf('function isSelfGatedPath()');
    if (start < 0) throw new Error(`isSelfGatedPath not found in ${relPath}`);
    return source.slice(start, source.indexOf('}', source.indexOf('return', start)));
  };

  test.each(['client/src/utils/runtimeBasePath.js', 'client/src/auth-gate/auth-gate.js'])(
    '%s lets shared chats and the detector through',
    relPath => {
      const body = exemptionIn(relPath);
      expect(body).toContain("'/share/'");
      expect(body).toContain("'/verify'");
      expect(body).toContain("'/verify/'");
    }
  );
});
