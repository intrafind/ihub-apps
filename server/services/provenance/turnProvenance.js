// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Build, store and return the provenance object of one AI output.
 *
 * Every channel (chat, inference API, MCP, A2A) calls {@link recordTextOutput}
 * with the text the caller actually receives: after structured-output
 * validation, before citation markers or Markdown rendering. A failure of the
 * store never fails the user's request; the object is still returned.
 *
 * @module services/provenance/turnProvenance
 */
import logger from '../../utils/logger.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { buildApiPath } from '../../utils/basePath.js';
import { resolveMcpPublicBase } from '../mcp/mcpOAuthPublicUrl.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { provenanceSettings } from './provenanceSettings.js';
import { buildProvenance, hashText, normalizeText, newOutputId } from './records.js';

const COMPONENT = 'TurnProvenance';

/** Path of the lookup endpoint, relative to the public base. */
export const VERIFY_PATH = '/api/provenance/_verify';

/**
 * The verify URL embedded in an object: absolute when a request (or the
 * configured public URL) tells us the public base, else the site-relative path
 * including iHub's base path. Built at response time, never stored in a record.
 *
 * @param {import('express').Request} [req]
 * @returns {string}
 */
export function verifyUrl(req) {
  let base = null;
  try {
    base = resolveMcpPublicBase(req);
  } catch {
    base = null;
  }
  return base ? `${base}${VERIFY_PATH}` : buildApiPath('/provenance/_verify');
}

/**
 * Record one text output and return its provenance object.
 *
 * @param {Object} input
 * @param {string} [input.outputId] - Allocated early (headers); minted when absent.
 * @param {string} input.text - The complete output text. Hashed, never stored.
 * @param {string} [input.finalText] - Final-step text of a multi-step turn; when
 *   it differs, the same record is also indexed under its hash.
 * @param {{id: string}} input.model - `{ id }`; workflows use `workflow:<id>`.
 * @param {Object} [input.modelConfig] - Model config for `contentMarking`.
 * @param {boolean} [input.watermarkApplied] - Set by the generation path (#3331).
 * @param {string} [input.keyId] - Watermark key id used (#3331).
 * @param {import('express').Request} [input.req] - For an absolute verify URL.
 * @returns {Promise<Object|null>} The object, or null for an output without text and tool calls.
 */
export async function recordTextOutput({
  outputId,
  text,
  finalText,
  model,
  modelConfig,
  watermarkApplied,
  keyId,
  req
}) {
  const hasText = typeof text === 'string' && normalizeText(text) !== '';
  if (!hasText) return null;
  try {
    const store = getProvenanceStore();
    const settings = provenanceSettings();
    const installationId = await store.installationId();
    const provenance = buildProvenance({
      outputId: outputId || newOutputId(),
      text,
      model,
      modelConfig,
      watermarkApplied,
      keyId,
      installationId,
      version: getAppVersion(),
      verifyUrl: verifyUrl(req)
    });
    if (settings.storeRecords) {
      const extraHashes =
        typeof finalText === 'string' && normalizeText(finalText) !== ''
          ? [hashText(finalText)]
          : [];
      try {
        await store.record(provenance, { extraHashes });
      } catch (error) {
        logger.warn('Could not store a provenance record', {
          component: COMPONENT,
          error: error.message
        });
      }
    }
    return provenance;
  } catch (error) {
    logger.warn('Could not build provenance', { component: COMPONENT, error: error.message });
    return null;
  }
}

export { newOutputId };
