/**
 * Executor for `structured-record` workflow nodes.
 *
 * Sits inside a `forEach` loop body. Reads the per-document LLM extraction
 * from a preceding `prompt` node, validates it against a named schema from
 * the schema registry, and appends a structured record to a configurable
 * state array (default `_evidence` — kept for backwards compatibility with
 * the audit-evidence workflows that introduced this node type).
 *
 * The record envelope shape is defined by `validators/evidenceRecordSchema.js`
 * and is shared with the agent-tool path so both routes (workflow execution
 * and agent execution) produce structurally identical records.
 *
 * @module services/workflow/executors/StructuredRecordNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { collectStructuredRecord } from '../../structuredRecord/collectStructuredRecord.js';

export class StructuredRecordNodeExecutor extends BaseNodeExecutor {
  /**
   * @param {Object} node
   * @param {Object} state
   * @param {Object} context
   */
  async execute(node, state, context) {
    try {
      this.validateConfig(node, ['schemaName', 'schemaVersion']);
    } catch (err) {
      return this.createErrorResult(err.message, { nodeId: node?.id });
    }

    const config = node.config || {};
    const {
      schemaName,
      schemaVersion,
      inputPath = '$.data._extractionOutput',
      sourcePath = '$.data._loopItem',
      evidenceVar = '_evidence',
      classificationPath,
      llmMetadataPath,
      iterationIndexPath = '$.data._loopIndex'
    } = config;

    const rawExtractionRaw = this.resolveVariable(inputPath, state);
    if (rawExtractionRaw === undefined || rawExtractionRaw === null) {
      return this.createErrorResult(
        `structured-record node '${node.id}' could not resolve inputPath '${inputPath}' — ` +
          `the preceding prompt node must place its structured output at that path.`,
        { nodeId: node.id, inputPath }
      );
    }

    // The LLM is supposed to emit JSON per the prompt's outputSchema, but some
    // models still return the JSON as a raw string (sometimes wrapped in
    // ```json fences). Parse if needed so the downstream schema validation
    // sees an object — otherwise every record fails with
    // EXTRACTION_SCHEMA_MISMATCH ("Expected object, received string").
    const rawExtraction = coerceLlmJson(rawExtractionRaw);

    const sourceRaw = this.resolveVariable(sourcePath, state) || {};
    const source = normalizeSource(sourceRaw, config.sourceSystem);

    const quotes = Array.isArray(rawExtraction?.quotes)
      ? rawExtraction.quotes.map(toQuoteRecord)
      : [];

    const classification = classificationPath
      ? this.resolveVariable(classificationPath, state)
      : rawExtraction?.classification;

    const llm = llmMetadataPath
      ? this.resolveVariable(llmMetadataPath, state)
      : undefined;

    const iterationIndex = toNumberOrUndefined(
      this.resolveVariable(iterationIndexPath, state)
    );

    const runId =
      context?.runId ||
      context?.executionId ||
      state?.metadata?.runId ||
      state?.metadata?.executionId;

    // The extraction payload may carry the structured fields directly OR
    // nest them under `.data` (some workflows wrap the prompt's JSON
    // explicitly). Accept either; collectStructuredRecord validates the
    // data shape.
    const extractionData =
      rawExtraction && typeof rawExtraction === 'object' && 'data' in rawExtraction
        ? rawExtraction.data
        : rawExtraction;

    const { record } = collectStructuredRecord({
      runId,
      nodeId: node.id,
      iterationIndex,
      schemaName,
      schemaVersion,
      rawExtraction: extractionData,
      source,
      quotes,
      classification,
      llm
    });

    const existing = Array.isArray(this.resolveVariable(`$.data.${evidenceVar}`, state))
      ? this.resolveVariable(`$.data.${evidenceVar}`, state)
      : [];
    const nextEvidence = [...existing, record];

    this.logger.info('Structured record collected', {
      component: 'StructuredRecordNodeExecutor',
      nodeId: node.id,
      evidenceId: record.evidenceId,
      docId: record.source?.docId,
      status: record.status,
      failureCount: record.failures?.length || 0,
      totalRecords: nextEvidence.length
    });

    return this.createSuccessResult(
      { evidenceId: record.evidenceId, status: record.status },
      {
        stateUpdates: {
          [evidenceVar]: nextEvidence
        }
      }
    );
  }
}

/**
 * Coerce an LLM-emitted "JSON" into a real JS object. Models commonly:
 *   - return the JSON as a plain string (e.g. when no responseFormat is set)
 *   - wrap the JSON in ```json ... ``` fences
 *   - prepend prose before the opening brace
 * This walks each of those shapes to recover the object. If parsing fails,
 * returns the original value so downstream validation surfaces a clean error.
 */
function coerceLlmJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return value;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return value;
  }
}

function normalizeSource(raw, configuredSystem) {
  if (!raw || typeof raw !== 'object') {
    return { docId: 'unknown', sourceSystem: configuredSystem || 'upload' };
  }
  // Common loop-item shapes from corpus_search results.
  const docId = raw.docId || raw.id || raw.documentId || 'unknown';
  return {
    docId: String(docId),
    sourceSystem: configuredSystem || raw.sourceSystem || 'ifinder',
    title: raw.title || raw.name,
    url: raw.url || raw.deepLink,
    retrievedAt: raw.retrievedAt || raw.indexingDate || new Date().toISOString()
  };
}

function toQuoteRecord(q) {
  if (typeof q === 'string') {
    return { text: q, validated: false };
  }
  if (q && typeof q === 'object') {
    return {
      text: String(q.text ?? q.quote ?? ''),
      locator: q.locator || pickLocator(q),
      validated: Boolean(q.validated)
    };
  }
  return { text: '', validated: false };
}

function pickLocator(q) {
  const locator = {};
  if (q.page != null) locator.page = Number(q.page);
  if (q.section) locator.section = String(q.section);
  return Object.keys(locator).length ? locator : undefined;
}

function toNumberOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export default StructuredRecordNodeExecutor;
