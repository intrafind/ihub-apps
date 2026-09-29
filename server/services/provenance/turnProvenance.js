/**
 * The one call every producer of AI output makes at the end of a turn — chat,
 * inference API, MCP, A2A, workflows. Never throws: provenance must not fail
 * a turn that already produced its answer.
 *
 * @module services/provenance/turnProvenance
 */
import provenanceStore from './ProvenanceStore.js';
import logger from '../../utils/logger.js';

/**
 * @param {Object} params
 * @param {string} params.content - the final answer text
 * @param {Object|null} params.model - model config
 * @param {Object|null} [params.app] - app config
 * @param {number|null} [params.temperature]
 * @param {Object[]} [params.images] - generated images (with their `provenance`)
 * @param {'chat'|'inference'|'mcp'|'a2a'|'workflow'} [params.kind='chat']
 * @returns {Promise<Object|null>} public provenance, or null
 */
export async function recordTurnProvenance({
  content,
  model,
  app = null,
  temperature = null,
  images = [],
  kind = 'chat'
}) {
  try {
    return await provenanceStore.recordText({
      content,
      kind,
      model,
      app,
      temperature: typeof temperature === 'number' ? temperature : Number(temperature) || null,
      images: (images || []).map(i => i?.provenance).filter(Boolean)
    });
  } catch (error) {
    logger.warn('Provenance record failed', { component: 'Provenance', error: error.message });
    return null;
  }
}
