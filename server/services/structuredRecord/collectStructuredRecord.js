import { randomUUID } from 'crypto';
import { evidenceRecordSchema } from '../../validators/evidenceRecordSchema.js';
import { getExtractionSchema } from './schemas.js';
import { jsonSchemaToZod } from './jsonSchemaToZod.js';

/**
 * Build a validated structured record from a per-document LLM extraction.
 *
 * Used by `StructuredRecordNodeExecutor` (workflow path) and the
 * `evidence_collect` agent tool (agent path) so both surfaces share one
 * implementation and produce structurally identical records. The envelope
 * shape is currently audit-evidence-flavored (`evidenceId`, optional
 * `quotes`, `failures` for soft-fail) since that is the first concrete
 * consumer; a second consumer with different envelope needs would warrant
 * a generic record schema in this directory.
 *
 * Schema resolution precedence:
 *   1. Inline `schema` (JSON Schema) — converted on the fly via jsonSchemaToZod.
 *      Lets workflow authors define new shapes without shipping code.
 *   2. Named `schemaName` + `schemaVersion` — looked up in the registry.
 *      Useful for shared schemas reused across workflows.
 *   3. Neither — validation is skipped; the upstream prompt's
 *      `outputSchema` (sent to the LLM as responseSchema) is the primary
 *      shape guarantee.
 *
 * @param {Object} args
 * @param {string} args.runId
 * @param {string} args.nodeId
 * @param {number} [args.iterationIndex]
 * @param {Object} [args.schema]                 inline JSON Schema (preferred over schemaName)
 * @param {string} [args.schemaName]             e.g. 'stellungnahmenReview'
 * @param {string} [args.schemaVersion]          e.g. 'v1'
 * @param {Object} args.rawExtraction            shape declared by the schema
 * @param {Object} args.source                   { docId, sourceSystem, title?, url?, retrievedAt? }
 * @param {Array}  [args.quotes]                 pre-extracted quotes (will be validated later)
 * @param {Object} [args.classification]
 * @param {Object} [args.llm]                    { model?, promptHash?, tokensIn?, tokensOut? }
 * @returns {{ record: Object, failures: Array<{code: string, message: string}> }}
 */
export function collectStructuredRecord(args) {
  const {
    runId,
    nodeId,
    iterationIndex,
    schema,
    schemaName,
    schemaVersion,
    rawExtraction,
    source,
    quotes = [],
    classification,
    llm
  } = args || {};

  const failures = [];
  let extractionData = rawExtraction;
  let status = 'ok';

  // 1. Validate the LLM extraction against the configured schema.
  //    Inline > named > skip. Failures soft-fail with `status='failed'`
  //    and the original payload retained for human inspection.
  const extractionSchema = resolveSchema({ schema, schemaName, schemaVersion });
  if (extractionSchema) {
    try {
      extractionData = extractionSchema.parse(rawExtraction);
    } catch (err) {
      status = 'failed';
      failures.push({
        code: 'EXTRACTION_SCHEMA_MISMATCH',
        message: err?.message || 'extraction did not match declared schema'
      });
      extractionData = rawExtraction ?? {};
    }
  }

  const record = {
    evidenceId: randomUUID(),
    runId: String(runId || ''),
    nodeId: String(nodeId || ''),
    iterationIndex,
    source: source || { docId: 'unknown', sourceSystem: 'upload' },
    extraction: {
      schemaName,
      schemaVersion,
      data: extractionData
    },
    quotes: Array.isArray(quotes) ? quotes : [],
    classification,
    llm,
    status,
    failures
  };

  // 2. Validate the record envelope. Envelope failures are programmer errors
  // (missing runId, malformed source); they get surfaced loudly rather than
  // silently downgraded.
  const envelope = evidenceRecordSchema.safeParse(record);
  if (!envelope.success) {
    record.status = 'failed';
    record.failures.push({
      code: 'EVIDENCE_ENVELOPE_INVALID',
      message: envelope.error?.issues
        ?.map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ') || 'evidence envelope failed validation'
    });
  }

  return { record, failures: record.failures };
}

function resolveSchema({ schema, schemaName, schemaVersion }) {
  if (schema && typeof schema === 'object') {
    return jsonSchemaToZod(schema);
  }
  if (schemaName) {
    try {
      return getExtractionSchema(schemaName, schemaVersion);
    } catch {
      return null;
    }
  }
  return null;
}

export default collectStructuredRecord;
