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
import { isEuAiActEnabled } from '../euAiAct/conformity.js';
import logger from '../../utils/logger.js';
import { getAppVersion } from '../../utils/versionHelper.js';
import { getProvenanceStore } from './ProvenanceStore.js';
import { provenanceSettings } from './provenanceSettings.js';
import { buildProvenance, hashText, normalizeText, newOutputId } from './records.js';

const COMPONENT = 'TurnProvenance';

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
 * @param {Object|null} [input.marking] - The generation path's watermark plan
 *   (`result.marking`, #3331): `{applied, keyId?, reason?}`. Wins over the two
 *   fields below.
 * @param {boolean} [input.watermarkApplied] - Explicit override (tests, media).
 * @param {string} [input.keyId] - Watermark key id used.
 * @returns {Promise<Object|null>} The object, or null for an output without text and tool calls.
 */
export async function recordTextOutput({
  outputId,
  text,
  finalText,
  model,
  modelConfig,
  marking,
  watermarkApplied,
  keyId
}) {
  // EU AI Act master switch off: no record, no object (callers are null-safe).
  if (!isEuAiActEnabled()) return null;
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
      watermarkApplied: marking ? marking.applied === true : watermarkApplied,
      keyId: marking?.keyId ?? keyId,
      watermarkReason: marking && marking.applied !== true ? marking.reason : undefined,
      installationId,
      version: getAppVersion()
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
