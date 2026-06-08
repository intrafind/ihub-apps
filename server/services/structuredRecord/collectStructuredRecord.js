import { randomUUID } from 'crypto';
import { structuredRecordSchema } from './recordSchema.js';
import { jsonSchemaToZod } from './jsonSchemaToZod.js';

/**
 * Build a validated structured record from a per-document LLM extraction.
 *
 * Used by `StructuredRecordNodeExecutor` (workflow path) and the
 * `evidence_collect` agent tool (agent path) so both surfaces produce
 * structurally identical records.
 *
 * Optional inline JSON Schema validates `rawExtraction`. Without a schema,
 * validation is skipped and the upstream prompt's `outputSchema` (sent to
 * the LLM as responseSchema) is the primary shape guarantee.
 *
 * @param {Object} args
 * @param {string} args.runId
 * @param {string} args.nodeId
 * @param {number} [args.iterationIndex]
 * @param {Object} [args.schema]            inline JSON Schema for the extraction
 * @param {Object} args.rawExtraction       payload from the per-document LLM call
 * @param {Object} args.source              { docId, sourceSystem, title?, url?, retrievedAt? }
 * @param {Array}  [args.quotes]            pre-extracted quotes (validated later by quote-validator)
 * @returns {{ record: Object, failures: Array<{code: string, message: string}> }}
 */
export function collectStructuredRecord(args) {
  const { runId, nodeId, iterationIndex, schema, rawExtraction, source, quotes = [] } = args || {};

  const failures = [];
  let data = rawExtraction;
  let status = 'ok';

  if (schema && typeof schema === 'object') {
    try {
      data = jsonSchemaToZod(schema).parse(rawExtraction);
    } catch (err) {
      status = 'failed';
      failures.push({
        code: 'EXTRACTION_SCHEMA_MISMATCH',
        message: err?.message || 'extraction did not match declared schema'
      });
      data = rawExtraction ?? {};
    }
  }

  const record = {
    recordId: randomUUID(),
    runId: String(runId || ''),
    nodeId: String(nodeId || ''),
    iterationIndex,
    source: source || { docId: 'unknown', sourceSystem: 'upload' },
    data,
    quotes: Array.isArray(quotes) ? quotes : [],
    status,
    failures
  };

  // Envelope validation surfaces programmer errors (missing runId, malformed
  // source) loudly rather than silently downgrading status.
  const envelope = structuredRecordSchema.safeParse(record);
  if (!envelope.success) {
    record.status = 'failed';
    record.failures.push({
      code: 'RECORD_ENVELOPE_INVALID',
      message:
        envelope.error?.issues?.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') ||
        'record envelope failed validation'
    });
  }

  return { record, failures: record.failures };
}

export default collectStructuredRecord;
