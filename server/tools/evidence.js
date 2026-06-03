/**
 * Evidence tool family.
 *
 * Exposes the audit-evidence primitives to agents (and any other LLM-driven
 * tool caller). The core logic lives in the now-split service modules
 * (`services/structuredRecord/`, `services/auditQuotes/`,
 * `services/templating/`) and is shared with the workflow node executors so
 * both surfaces produce structurally identical Evidence records and reports.
 *
 * Three functions:
 *
 *   - collect(args) — validate a per-document LLM extraction against a
 *     named schema and build an Evidence record.
 *
 *   - validateQuotesFastPath(args) — normalized substring check across a
 *     batch of quotes against a source text. Returns per-quote verdicts;
 *     for each miss the agent decides whether to accept it (inline LLM
 *     reasoning in the agent's own context) or flag it.
 *
 *   - composeReport(args) — render an evidence-based Markdown report.
 *     Optional artifact write through `writeArtifactDirect` when runId
 *     is provided.
 *
 * @module tools/evidence
 */

import { collectStructuredRecord } from '../services/structuredRecord/collectStructuredRecord.js';
import { planQuoteValidation } from '../services/auditQuotes/validateQuotes.js';
import { composeReport as composeReportCore } from '../services/templating/composeReport.js';
import { writeArtifactDirect } from '../agents/runtime/artifactStore.js';

/**
 * Build an Evidence record from a per-document extraction.
 *
 * @param {Object} params
 * @param {string} params.runId
 * @param {string} [params.nodeId='agent.evidence.collect']
 * @param {number} [params.iterationIndex]
 * @param {string} params.schemaName        e.g. 'stellungnahmenReview'
 * @param {string} params.schemaVersion     e.g. 'v1'
 * @param {Object} params.extraction        raw shape declared by the schema
 * @param {Object} params.source            { docId, sourceSystem, title?, url? }
 * @param {Array}  [params.quotes]          per-quote entries to attach
 * @param {Object} [params.classification]
 * @param {Object} [params.llm]             { model?, promptHash?, tokensIn?, tokensOut? }
 * @returns {Promise<{ ok: boolean, evidenceId: string, status: string, failures: Array, record: Object }>}
 */
export async function collect(params) {
  const {
    runId,
    nodeId = 'agent.evidence.collect',
    iterationIndex,
    schemaName,
    schemaVersion,
    extraction,
    source,
    quotes,
    classification,
    llm
  } = params || {};

  if (!schemaName || !schemaVersion) {
    return {
      ok: false,
      error: 'schemaName and schemaVersion are required'
    };
  }
  if (!source || !source.docId) {
    return {
      ok: false,
      error: 'source.docId is required so the evidence record can be linked back to its origin'
    };
  }

  const { record, failures } = collectStructuredRecord({
    runId,
    nodeId,
    iterationIndex,
    schemaName,
    schemaVersion,
    rawExtraction: extraction,
    source,
    quotes,
    classification,
    llm
  });

  return {
    ok: record.status !== 'failed',
    evidenceId: record.evidenceId,
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
 * @param {Array}  [params.evidence=[]]
 * @param {Object} [params.coverage]
 * @param {string} [params.synthesis='']
 * @param {string} [params.template]              workflow-author template
 * @param {Object} [params.extra]                 additional template context
 * @param {string} [params.runId]                 if present, persist via artifactStore
 * @param {string} [params.artifactName='final-report.md']
 * @param {string} [params.chatId]
 * @returns {Promise<{ ok: boolean, markdown: string, bytes: number, artifactName?: string, artifactPath?: string }>}
 */
export async function composeReport(params) {
  const {
    evidence = [],
    coverage,
    synthesis = '',
    template,
    extra = {},
    runId,
    artifactName = 'final-report.md',
    chatId
  } = params || {};

  const { markdown, bytes } = composeReportCore({
    evidence,
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
      // Surface the persistence failure but still return the rendered markdown
      // so the agent can continue (or include the report inline in its response).
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
