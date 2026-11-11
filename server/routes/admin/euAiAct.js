// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin API of the EU AI Act overview page (#3329).
 *
 * `eu-ai-act` is a namespace, not a collection (fixed by the issue). The key,
 * detector and self-test endpoints the page also uses belong to #3331
 * (`/api/admin/watermark-*`), the acknowledgement actions to #3326.
 *
 * @module routes/admin/euAiAct
 */
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { buildStatus } from '../../services/euAiAct/statusService.js';

export default function registerAdminEuAiActRoutes(app) {
  /**
   * @swagger
   * /api/admin/eu-ai-act/status:
   *   get:
   *     summary: Configuration check for EU AI Act Art. 50
   *     description: >-
   *       Traffic-light checks (`ok`, `warn`, `error`) of the disclosure, acknowledgement,
   *       provenance and watermark settings, one row per model and the acknowledgement counts.
   *       The detectors are probed with a throwaway key (3 s timeout, cached 30 s);
   *       `refresh=true` probes again. Never contains a key or token. "ok" means configured as
   *       designed, not legally compliant.
   *     tags: [Admin - EU AI Act]
   *     parameters:
   *       - { in: query, name: refresh, schema: { type: boolean } }
   *     responses:
   *       200: { description: "`{ generatedAt, summary, checks, models, acknowledgements, provenance }`" }
   */
  app.get(buildServerPath('/api/admin/eu-ai-act/status'), adminAuth, async (req, res) => {
    const status = await buildStatus({ refresh: req.query.refresh === 'true' });
    res.set('Cache-Control', 'no-store');
    res.json(status);
  });
}
