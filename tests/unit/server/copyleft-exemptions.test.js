import { readFileSync } from 'fs';
import path from 'path';

/**
 * .github/dependency-review-config.yml lets nextcloud-app (an AGPL Nextcloud
 * plugin) use GPL/AGPL Nextcloud libraries through allow-dependencies-licenses.
 * The dependency review action cannot tell which manifest adds a package, so
 * that exemption would also wave one of these packages through in the core
 * platform. Keep them out of every other manifest here instead.
 */

const repoRoot = path.resolve(__dirname, '../../..');

/** npm package names listed under allow-dependencies-licenses. */
function exemptedPackages() {
  const config = readFileSync(path.join(repoRoot, '.github/dependency-review-config.yml'), 'utf8');
  const section = config.match(/^allow-dependencies-licenses:\n((?:\s+- .+\n?)+)/m);
  if (!section) throw new Error('allow-dependencies-licenses not found');
  return [...section[1].matchAll(/pkg:npm\/(\S+)/g)].map(m => decodeURIComponent(m[1]));
}

/** Names of every dependency npm installs from the manifest at |relPath|. */
function dependenciesOf(relPath) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'));
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies
  });
}

describe('copyleft license exemptions', () => {
  test('the exemption list is read from the dependency review config', () => {
    expect(exemptedPackages()).toContain('@nextcloud/vue');
  });

  test.each(['package.json', 'client/package.json', 'server/package.json'])(
    '%s does not depend on a package exempted only for nextcloud-app',
    manifest => {
      const exempted = new Set(exemptedPackages());
      expect(dependenciesOf(manifest).filter(name => exempted.has(name))).toEqual([]);
    }
  );
});
