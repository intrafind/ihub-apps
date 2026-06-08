/**
 * Executor for `structured-record` workflow nodes.
 *
 * Reads the per-document LLM extraction from a preceding `prompt` node,
 * optionally validates it against the node's inline `schema` (JSON Schema),
 * and appends a structured record to a configurable state array (default
 * `_records`).
 *
 * Record envelope shape: see `services/structuredRecord/recordSchema.js`.
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
    const config = node.config || {};
    const {
      schema,
      inputPath = '$.data._extractionOutput',
      sourcePath = '$.data._loopItem',
      recordsVar = '_records',
      iterationIndexPath = '$.data._loopIndex'
    } = config;

    const sourceRaw = this.resolveVariable(sourcePath, state) || {};
    const source = normalizeSource(sourceRaw, config.sourceSystem);
    const iterationIndex = toNumberOrUndefined(this.resolveVariable(iterationIndexPath, state));
    const runId =
      context?.runId ||
      context?.executionId ||
      state?.metadata?.runId ||
      state?.metadata?.executionId;

    const rawExtractionRaw = this.resolveVariable(inputPath, state);

    // Soft-fail when the upstream prompt produced no output. The LLM may
    // have errored, returned empty content, been blocked by a safety
    // filter, or failed to produce parseable JSON. We record this as a
    // failed entry with a clear failure note and let the workflow
    // continue — one bad iteration must not poison the whole run.
    if (rawExtractionRaw === undefined || rawExtractionRaw === null) {
      this.logger.warn('No extraction output — recording soft failure', {
        component: 'StructuredRecordNodeExecutor',
        nodeId: node.id,
        inputPath,
        docId: source.docId
      });

      const { record: emptyRecord } = collectStructuredRecord({
        runId,
        nodeId: node.id,
        iterationIndex,
        rawExtraction: {},
        source,
        quotes: []
      });
      emptyRecord.status = 'failed';
      emptyRecord.failures.push({
        code: 'NO_EXTRACTION_OUTPUT',
        message:
          `Upstream prompt produced no output at ${inputPath}. ` +
          `The LLM may have errored, returned empty content, or been blocked by a safety filter.`
      });

      const existing = Array.isArray(this.resolveVariable(`$.data.${recordsVar}`, state))
        ? this.resolveVariable(`$.data.${recordsVar}`, state)
        : [];
      const nextRecords = [...existing, emptyRecord];

      return this.createSuccessResult(
        { recordId: emptyRecord.recordId, status: 'failed' },
        { stateUpdates: { [recordsVar]: nextRecords } }
      );
    }

    // The LLM is supposed to emit JSON per the prompt's outputSchema, but some
    // models still return the JSON as a raw string (sometimes wrapped in
    // ```json fences). Parse if needed so the downstream schema validation
    // sees an object — otherwise every record fails with
    // EXTRACTION_SCHEMA_MISMATCH ("Expected object, received string").
    const rawExtraction = coerceLlmJson(rawExtractionRaw);

    const quotes = Array.isArray(rawExtraction?.quotes)
      ? rawExtraction.quotes.map(toQuoteRecord)
      : [];

    // The extraction payload may carry the structured fields directly OR
    // nest them under `.data` (some workflows wrap the prompt's JSON
    // explicitly). Accept either; collectStructuredRecord validates the
    // data shape.
    const extractionData =
      rawExtraction && typeof rawExtraction === 'object' && 'data' in rawExtraction
        ? rawExtraction.data
        : rawExtraction;

    const { record } = collectStructuredRecord({
      schema,
      runId,
      nodeId: node.id,
      iterationIndex,
      rawExtraction: extractionData,
      source,
      quotes
    });

    const existing = Array.isArray(this.resolveVariable(`$.data.${recordsVar}`, state))
      ? this.resolveVariable(`$.data.${recordsVar}`, state)
      : [];
    const nextRecords = [...existing, record];

    this.logger.info('Structured record collected', {
      component: 'StructuredRecordNodeExecutor',
      nodeId: node.id,
      recordId: record.recordId,
      docId: record.source?.docId,
      status: record.status,
      failureCount: record.failures?.length || 0,
      totalRecords: nextRecords.length
    });

    return this.createSuccessResult(
      { recordId: record.recordId, status: record.status },
      {
        stateUpdates: {
          [recordsVar]: nextRecords
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
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
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
  // Common loop-item shapes from corpus_search results AND chat-uploaded
  // file shapes (which carry `fileName` but no explicit `docId`/`title`).
  // Fall back to fileName so per-upload records still get distinct
  // identifiers + a human-readable title without requiring a custom
  // fanout step in the workflow.
  const docId = raw.docId || raw.id || raw.documentId || raw.fileName || 'unknown';
  return {
    docId: String(docId),
    sourceSystem: configuredSystem || raw.sourceSystem || 'ifinder',
    title: raw.title || raw.name || raw.fileName,
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
