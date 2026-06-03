/**
 * Render a Markdown report from a workflow-author-supplied template and a
 * conventional context shape (`{evidence, coverage, synthesis, ...extra}`).
 *
 * Pure function so the caller can persist the result however it likes
 * (artifact store, response body, test fixture). The context arg names
 * (`evidence`, `coverage`, `synthesis`) are an aggregation convention used by
 * audit-evidence workflows — a non-audit caller can simply pass empty
 * defaults and put its own keys under `extra`.
 *
 * No default template is provided: omitting `template` is treated as a
 * configuration error so misconfigured workflows fail loudly rather than
 * silently producing audit-flavored output.
 *
 * @module services/templating/composeReport
 */

import { renderTemplate } from './renderTemplate.js';

/**
 * @param {Object} args
 * @param {string} args.template            author-supplied template (required)
 * @param {Array}  [args.evidence]          list of records (state.data._evidence by convention)
 * @param {Object} [args.coverage]          coverage state (state.data._coverage by convention)
 * @param {string} [args.synthesis]         optional pre-computed cross-document text
 * @param {Object} [args.extra]             additional template context (run id, workflow id, etc.)
 * @returns {{ markdown: string, bytes: number }}
 */
export function composeReport(args) {
  const {
    evidence = [],
    coverage,
    synthesis = '',
    template,
    extra = {}
  } = args || {};

  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('composeReport: `template` is required');
  }

  const context = {
    evidence: Array.isArray(evidence) ? evidence : [],
    coverage: hydrateCoverage(coverage),
    synthesis: synthesis || '',
    ...extra
  };

  const markdown = renderTemplate(template, context);
  return {
    markdown,
    bytes: Buffer.byteLength(markdown)
  };
}

function hydrateCoverage(c) {
  return {
    candidates: c?.candidates || { total: 0 },
    processed: c?.processed ?? 0,
    skipped: Array.isArray(c?.skipped) ? c.skipped : [],
    failed: Array.isArray(c?.failed) ? c.failed : [],
    quotesChecked: c?.quotesChecked ?? 0,
    quotesValidated: c?.quotesValidated ?? 0,
    startedAt: c?.startedAt,
    completedAt: c?.completedAt
  };
}

export default composeReport;
