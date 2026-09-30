/**
 * The one call every producer of AI output makes at the end of a turn — chat,
 * inference API, MCP, A2A, workflows. Never throws: provenance must not fail
 * a turn that already produced its answer.
 *
 * @module services/provenance/turnProvenance
 */
import configCache from '../../configCache.js';
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
/**
 * A finite temperature, or null when none is set. Zero stays zero: at
 * temperature 0 the vLLM watermark cannot be embedded, so it must not read as
 * "not set" (which counts as marked).
 * @param {*} value
 * @returns {number|null}
 */
function toTemperature(value) {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(t) ? t : null;
}

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
      temperature: toTemperature(temperature),
      images: (images || []).map(i => i?.provenance).filter(Boolean)
    });
  } catch (error) {
    logger.warn('Provenance record failed', { component: 'Provenance', error: error.message });
    return null;
  }
}

/** Workflow node types whose output a model writes. */
const GENERATIVE_NODE_TYPES = new Set(['prompt', 'planner']);

/**
 * Provenance of a workflow's final output for machine clients (MCP, A2A).
 * Only workflows with a generative node produce AI content; a workflow of
 * HTTP, code or transform nodes gets no record. The model is named only when
 * every generative node pins the same one; otherwise it is resolved at run
 * time and the record says "unknown model" (unmarked).
 *
 * @param {{workflow: Object, output: *}} params
 * @returns {Promise<Object|null>}
 */
export async function recordWorkflowProvenance({ workflow, output }) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const generative = nodes.filter(n => GENERATIVE_NODE_TYPES.has(n?.type));
  if (generative.length === 0) return null;
  const content = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const pinned = [...new Set(generative.map(n => n.config?.modelId || null))];
  const model =
    pinned.length === 1 && pinned[0]
      ? (configCache.getModels(true)?.data || []).find(m => m.id === pinned[0]) || null
      : null;
  return recordTurnProvenance({ content, model, kind: 'workflow' });
}
