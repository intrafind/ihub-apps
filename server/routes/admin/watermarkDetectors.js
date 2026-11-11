// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin API of the watermark detectors (#3331): list, connectivity test and
 * end-to-end self-test. The admin overview page (#3329) consumes these.
 *
 * @module routes/admin/watermarkDetectors
 */
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import llmClient from '../../services/loop/LLMClient.js';
import { getActiveKeyId } from '../../services/provenance/watermark/activeKeySnapshot.js';
import { listDetectorConfigs } from '../../services/provenance/watermark/detect.js';
import { checkDetectorUrl } from '../../services/provenance/watermark/detectorUrlPolicy.js';
import { recordSelfTest } from '../../services/euAiAct/selfTestStore.js';
import { pingDetector, runSelfTest } from '../../services/provenance/watermark/selfTest.js';

function findIhubModel(modelId) {
  const model = (configCache.getModels(true)?.data || []).find(item => item.id === modelId);
  if (!model || model.contentMarking?.text?.by !== 'ihub') {
    throw new ServiceError('NOT_FOUND', 'No model marked by iHub with this id');
  }
  return model;
}

export default function registerAdminWatermarkDetectorRoutes(app) {
  const base = '/api/admin/watermark-detectors';

  /**
   * @swagger
   * /api/admin/watermark-detectors:
   *   get:
   *     summary: List the detector settings of every model marked by iHub
   *     description: Static configuration; no network call and no key.
   *     tags: [Admin - Watermark]
   *     responses:
   *       200:
   *         description: "`{ items: [{ modelId, detectorUrl, tokenizer, algorithm, prf, contextWidth, credentialRef, hasActiveKey, urlPolicyOk, urlPolicyProblem? }], nextCursor: null }`"
   */
  app.get(buildServerPath(base), adminAuth, async (req, res) => {
    const configs = listDetectorConfigs({ includeDisabled: true });
    const hasActiveKey = Boolean(getActiveKeyId());
    const items = [];
    for (const config of configs) {
      const item = {
        modelId: config.modelId,
        detectorUrl: config.detectorUrl,
        tokenizer: config.tokenizer,
        algorithm: config.algorithm,
        prf: config.prf,
        contextWidth: config.contextWidth,
        credentialRef: config.credentialRef,
        hasActiveKey,
        urlPolicyOk: false
      };
      if (!config.detectorUrl) {
        item.urlPolicyProblem = 'No detector URL is configured';
      } else {
        const check = await checkDetectorUrl(config.detectorUrl);
        item.urlPolicyOk = check.ok;
        if (!check.ok) item.urlPolicyProblem = check.reason;
      }
      items.push(item);
    }
    res.json({ items, nextCursor: null });
  });

  /**
   * @swagger
   * /api/admin/watermark-detectors/{modelId}/_test:
   *   post:
   *     summary: Test the connection to a model's detector
   *     description: >-
   *       Calls the detector with a throwaway random key and a fixed sentence, so URL, TLS,
   *       token and response contract are checked without sending a real key. "Not
   *       reachable" is a result, not an error.
   *     tags: [Admin - Watermark]
   *     responses:
   *       200: { description: "`{ reachable, authenticated, contractValid, latencyMs, error? }`" }
   *       404: { description: No such model }
   *       409: { description: No detector URL or credential configured }
   */
  app.post(buildServerPath(`${base}/:modelId/_test`), adminAuth, async (req, res) => {
    const model = findIhubModel(req.params.modelId);
    res.json(await pingDetector(model));
  });

  /**
   * @swagger
   * /api/admin/watermark-detectors/{modelId}/_self-test:
   *   post:
   *     summary: Generate text with the model and detect it with all keys
   *     description: >-
   *       One real generation (about 350 words, temperature 1). Admin only, no retries.
   *       Tells whether iHub and vLLM agree on the key.
   *     tags: [Admin - Watermark]
   *     responses:
   *       200:
   *         description: "`{ ok, diagnosis: keys_match|matches_retired_key|no_watermark_found|too_short|detector_unreachable|not_applied|no_keys, status, matchedKeyId?, scoredTokens, pValue? }`"
   *       404: { description: No such model }
   *       409: { description: No detector URL or credential configured }
   */
  app.post(buildServerPath(`${base}/:modelId/_self-test`), adminAuth, async (req, res) => {
    const model = findIhubModel(req.params.modelId);
    const result = await runSelfTest(model, { llmClient, user: req.user });
    // The overview page (#3329) shows the last result and marks it outdated after a key change.
    await recordSelfTest(model.id, result);
    await logAudit({
      req,
      action: 'execute',
      resource: 'watermarkDetector',
      resourceId: model.id,
      summary: `Watermark self-test of ${model.id}: ${result.diagnosis}`,
      details: { diagnosis: result.diagnosis, matchedKeyId: result.matchedKeyId }
    });
    res.json(result);
  });
}
