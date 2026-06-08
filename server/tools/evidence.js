/**
 * Evidence tool family.
 *
 * Audit-flavored agent tool surface that wraps generic primitives from
 * `services/structuredRecord/`, `services/auditQuotes/`, and
 * `services/templating/`. Workflow node executors and this tool family
 * share the same core code so workflow runs and agent runs produce
 * structurally identical records.
 *
 *   - collect(args)                  build a structured record from a
 *                                    per-document extraction.
 *   - validateQuotesFastPath(args)   normalized substring check across a
 *                                    batch of quotes; misses are returned
 *                                    so the agent can decide via inline
 *                                    reasoning whether to accept them.
 *   - composeReport(args)            render Markdown from a template;
 *                                    optionally persist via artifactStore.
 *
 * @module tools/evidence
 */

import { collectStructuredRecord } from '../services/structuredRecord/collectStructuredRecord.js';
import { planQuoteValidation } from '../services/auditQuotes/validateQuotes.js';
import { composeReport as composeReportCore } from '../services/templating/composeReport.js';
import { writeArtifactDirect } from '../agents/runtime/artifactStore.js';

/**
 * Build a structured record from a per-document extraction.
 *
 * @param {Object} params
 * @param {string} params.runId
 * @param {string} [params.nodeId='agent.evidence.collect']
 * @param {number} [params.iterationIndex]
 * @param {Object} [params.schema]          inline JSON Schema for the extraction
 * @param {Object} params.extraction        raw payload from the per-document LLM call
 * @param {Object} params.source            { docId, sourceSystem, title?, url? }
 * @param {Array}  [params.quotes]          per-quote entries (validated later)
 * @returns {Promise<{ ok: boolean, recordId: string, status: string, failures: Array, record: Object }>}
 */
export async function collect(params) {
  const {
    runId,
    nodeId = 'agent.evidence.collect',
    iterationIndex,
    schema,
    extraction,
    source,
    quotes
  } = params || {};

  if (!source || !source.docId) {
    return {
      ok: false,
      error: 'source.docId is required so the record can be linked back to its origin'
    };
  }

  const { record, failures } = collectStructuredRecord({
    runId,
    nodeId,
    iterationIndex,
    schema,
    rawExtraction: extraction,
    source,
    quotes
  });

  return {
    ok: record.status !== 'failed',
    recordId: record.recordId,
    status: record.status,
    failures,
    record
  };
}

/**
 * Run the normalized-substring fast-path against a batch of quotes.
 *
 * Returns one verdict per quote with `validated`, `needsLlm`, and the
 * normalized form so the caller can construct an LLM fallback prompt
 * for the misses without re-doing normalization.
 *
 * @param {Object} params
 * @param {Array<{text: string}|string>} params.quotes
 * @param {string} params.sourceText
 * @returns {Promise<{ ok: boolean, verdicts: Array, summary: { total: number, validated: number, needsLlm: number } }>}
 */
export async function validateQuotesFastPath(params) {
  const { quotes = [], sourceText = '' } = params || {};
  if (!Array.isArray(quotes)) {
    return { ok: false, error: 'quotes must be an array' };
  }
  const verdicts = planQuoteValidation({ quotes, sourceText });
  const summary = {
    total: verdicts.length,
    validated: verdicts.filter(v => v.validated).length,
    needsLlm: verdicts.filter(v => v.needsLlm).length
  };
  return { ok: true, verdicts, summary };
}

/**
 * Render the final Markdown report and (optionally) persist it as a run
 * artifact.
 *
 * @param {Object} params
 * @param {Array}  [params.records=[]]            list of structured records
 * @param {Object} [params.coverage]
 * @param {string} [params.synthesis='']
 * @param {string} [params.template]              workflow-author template (required)
 * @param {Object} [params.extra]                 additional template context
 * @param {string} [params.runId]                 if present, persist via artifactStore
 * @param {string} [params.artifactName='final-report.md']
 * @param {string} [params.chatId]
 * @returns {Promise<{ ok: boolean, markdown: string, bytes: number, artifactName?: string, artifactPath?: string }>}
 */
export async function composeReport(params) {
  const {
    records = [],
    coverage,
    synthesis = '',
    template,
    extra = {},
    runId,
    artifactName = 'final-report.md',
    chatId
  } = params || {};

  const { markdown, bytes } = composeReportCore({
    records,
    coverage,
    synthesis,
    template,
    extra
  });

  let artifactPath = null;
  let persistedName = null;
  if (runId) {
    try {
      const result = await writeArtifactDirect({
        runId,
        name: artifactName,
        content: markdown,
        contentType: 'text/markdown',
        chatId: chatId || runId
      });
      artifactPath = result.path;
      persistedName = artifactName;
    } catch (err) {
      // Surface the persistence failure but still return the rendered markdown.
      return {
        ok: true,
        markdown,
        bytes,
        persistenceError: err.message
      };
    }
  }

  return {
    ok: true,
    markdown,
    bytes,
    artifactName: persistedName,
    artifactPath
  };
}

export default {
  collect,
  validateQuotesFastPath,
  composeReport
};
