import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { sendInternalError } from '../../utils/responseHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const releasesDir = join(__dirname, '../../../docs/releases');

/**
 * Compare semantic version strings (e.g. "5.4.0" > "5.3.1").
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export default function registerAdminChangelogRoutes(app) {
  /**
   * GET /api/admin/changelog
   * Returns the 5 most recent release changelogs parsed from docs/releases/.
   */
  app.get(buildServerPath('/api/admin/changelog'), adminAuth, async (req, res) => {
    try {
      let versions;
      try {
        const entries = await fs.readdir(releasesDir, { withFileTypes: true });
        versions = entries
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .sort(compareVersions)
          .slice(0, 5);
      } catch {
        return res.json([]);
      }

      const changelog = [];
      for (const version of versions) {
        const versionDir = join(releasesDir, version);
        let features = '';
        let breakingChanges = '';

        try {
          features = await fs.readFile(join(versionDir, 'features.md'), 'utf8');
        } catch {
          // No features file
        }

        try {
          breakingChanges = await fs.readFile(join(versionDir, 'breaking-changes.md'), 'utf8');
        } catch {
          // No breaking changes file
        }

        if (features || breakingChanges) {
          changelog.push({ version, features, breakingChanges });
        }
      }

      res.json(changelog);
    } catch (error) {
      return sendInternalError(res, error, 'fetch changelog');
    }
  });
}
